import MockRunner, {
    GraphExecutorV2,
    type GraphNodeV2,
    type LiveGraphConfigV2,
} from '@ondc/automation-mock-runner';

import { createCache } from '../../cache/cache-factory';
import { ICacheService } from '../../cache/cache-interface';
import { IQueueService } from '../../queue/IQueueService';
import {
    SessionCacheSchema,
    TransactionCacheSchema,
} from '../../types/cache-types';
import { WorkbenchCacheService } from '../cache/workbench-cache';
import {
    advanceLiveFlow,
    clearLiveExecutors,
    getLiveFlowStatus,
    LiveAdvanceJobParams,
    LiveDeps,
    liveConfigKey,
    liveRunKey,
    proceedLiveFlow,
    receiveLivePayload,
    startLiveFlow,
    STUDIO_LIVE_ADVANCE_JOB,
    STUDIO_LIVE_SEND_JOB,
    createStudioLiveSendJobHandler,
    describeDelivery,
    LiveSendJobParams,
} from './live-session';

const b64 = (src: string) => MockRunner.encodeBase64(src);

const GENERATE = b64(
    'async function generate(defaultPayload, sessionData) { if (sessionData.user_inputs) defaultPayload.message.inputs = sessionData.user_inputs; return defaultPayload; }'
);
const VALID = b64(
    'function validate(targetPayload, sessionData) { return { valid: true, code: 200, description: "ok" }; }'
);
const INVALID = b64(
    'function validate(targetPayload, sessionData) { return { valid: false, code: 30016, description: "bad item" }; }'
);
const REQUIREMENTS = b64(
    'function meetsRequirements(sessionData) { return { valid: true, code: 200, description: "ok" }; }'
);

const node = (
    id: string,
    api: string,
    patch: Partial<GraphNodeV2> = {}
): GraphNodeV2 => ({
    id,
    api,
    owner: api.startsWith('on_') ? 'BPP' : 'BAP',
    kind: api.startsWith('on_') ? 'callback' : 'request',
    responseFor: null,
    code: { generate: GENERATE, validate: VALID, requirements: REQUIREMENTS },
    defaultPayload: { context: {}, message: { from: id } },
    saveData: { latestMessage_id: '$.context.message_id' },
    ...patch,
});

const doc = (nodes: GraphNodeV2[]): LiveGraphConfigV2 => ({
    kind: 'graph-v2-live',
    meta: { domain: 'ONDC:TRV14', version: '2.0.0', playground_version: 'v2' },
    transaction_data: {
        transaction_id: 'tx-config',
        latest_timestamp: '2025-01-01T00:00:00.000Z',
    },
    graph: {
        nodes,
        edges: nodes.slice(1).map((n, i) => ({
            id: `e${i}`,
            from: nodes[i].id,
            to: n.id,
            kind: 'next' as const,
        })),
    },
    journeys: [
        {
            id: 'happy',
            title: 'Happy path',
            entry: nodes[0].id,
            choices: {},
            expects: {},
            onDemand: [],
        },
    ],
});

const LINEAR = [
    node('search', 'search'),
    node('on_search', 'on_search', { responseFor: 'search' }),
    node('select', 'select'),
    node('on_select', 'on_select', { responseFor: 'select' }),
];

const NP = 'https://np.example.com';

type Job = { name: string; data: unknown };

/** A queue that records jobs; the test runs advance jobs itself. */
const recordingQueue = (jobs: Job[]): IQueueService => ({
    process: () => undefined,
    on: () => undefined,
    close: async () => undefined,
    enqueue: async (name, data) => {
        jobs.push({ name, data });
        return `job-${jobs.length}`;
    },
});

const setup = async (npType: 'BAP' | 'BPP', nodes: GraphNodeV2[] = LINEAR) => {
    clearLiveExecutors();
    const cache: ICacheService = createCache('mock');
    const jobs: Job[] = [];
    const deps: LiveDeps = {
        cache,
        workbench: WorkbenchCacheService(cache),
        queue: recordingQueue(jobs),
    };
    await cache.set(
        'sess-1',
        {
            transactionIds: [],
            flowMap: {},
            npType,
            domain: 'ONDC:TRV14',
            version: '2.0.0',
            subscriberUrl: NP,
            usecaseId: 'PLAYGROUND-FLOW',
            engine: 'graph-v2',
            env: 'LOGGED-IN',
            flowConfigs: {},
        },
        SessionCacheSchema
    );
    await cache.set(liveConfigKey('sess-1'), doc(nodes), SessionCacheSchema);
    /** Runs the advance jobs enqueued so far; returns the payloads sent. */
    const drain = async () => {
        const sent: { action: string; payload: any; query: any }[] = [];
        while (jobs.length) {
            const job = jobs.shift()!;
            if (job.name === STUDIO_LIVE_ADVANCE_JOB)
                await advanceLiveFlow(deps, job.data as LiveAdvanceJobParams);
            else if (job.name === STUDIO_LIVE_SEND_JOB) {
                const data = job.data as any;
                sent.push({
                    action: data.action,
                    payload: data.payload,
                    query: data.queryParams,
                });
            }
        }
        return sent;
    };
    return { cache, deps, jobs, drain };
};

const fromNp = (action: string, messageId: string, extra = {}) => ({
    context: {
        action,
        message_id: messageId,
        transaction_id: 'tx-1',
        bap_uri: NP,
        bpp_uri: NP,
        ...extra,
    },
    message: { from: 'np' },
});

afterAll(() => GraphExecutorV2.terminateSharedRunner());

describe('Studio live sessions (graph-v2)', () => {
    it('as BAP: sends search, waits for on_search, receives it and sends select', async () => {
        const { deps, drain, cache } = await setup('BPP');
        const started = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        expect(started.success).toBe(true);
        let sent = await drain();
        expect(sent.map(s => s.action)).toEqual(['search']);
        expect(sent[0].query).toEqual({
            subscriber_url: NP,
            flow_id: 'happy',
            session_id: 'sess-1',
        });
        const search = sent[0].payload;
        expect(search.context.transaction_id).toBe('tx-1');
        // The mock's own ids and uris are the api-service's.
        expect(search.context.bap_uri).toMatch(/\/ONDC:TRV14\/2\.0\.0\/buyer$/);

        // The session now maps the journey to its transaction.
        const session: any = await cache.get('sess-1', SessionCacheSchema);
        expect(session.flowMap).toEqual({ happy: 'tx-1' });

        let status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
        expect(status.plays).toBe('BAP');
        expect(status.plan).toMatchObject({
            kind: 'await',
            nodeId: 'on_search',
        });
        expect(status.status).toMatchObject({
            search: 'done',
            on_search: 'awaiting',
        });

        const got = await receiveLivePayload(
            deps,
            fromNp('on_search', search.context.message_id),
            NP
        );
        expect(got).toMatchObject({ kind: 'accepted', nodeId: 'on_search' });
        sent = await drain();
        expect(sent.map(s => s.action)).toEqual(['select']);

        status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
        expect(status.state.runs.map(r => r.nodeId)).toEqual([
            'search',
            'on_search',
            'select',
        ]);
        expect(status.state.session.events[1].direction).toBe('in');
        expect(status.plan).toMatchObject({
            kind: 'await',
            nodeId: 'on_select',
        });
    });

    /** What the api-service does when the participant's first request consumes the expectation. */
    const consumeExpectation = async (
        cache: ICacheService,
        transactionId: string
    ) =>
        cache.set(
            `${transactionId}::${NP}`,
            {
                sessionId: 'sess-1',
                flowId: 'happy',
                latestAction: '',
                latestTimestamp: '',
                subscriberType: 'BAP',
                messageIds: [],
                apiList: [],
            },
            TransactionCacheSchema
        );

    it('as BPP: mints no transaction — it waits for the participant’s, like v1', async () => {
        const { deps, drain, cache } = await setup('BAP');
        // Even a transaction id offered by the caller is not the buyer's, so it is not used.
        const started = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-from-page',
        });
        expect(started).toMatchObject({
            success: true,
            awaiting: { nodeId: 'search', api: 'search' },
        });
        expect(started.transactionId).toBeUndefined();
        expect(started.message).toMatch(/Listening for search/);

        // Only the expectation exists: no run record, nothing on the session.
        const expectations: any = await cache.get(NP, SessionCacheSchema);
        expect(expectations.activeSessions).toEqual([
            expect.objectContaining({
                sessionId: 'sess-1',
                flowId: 'happy',
                expectedAction: 'search',
            }),
        ]);
        expect(
            await cache.get(liveRunKey('tx-from-page', NP), SessionCacheSchema)
        ).toBeNull();
        const before: any = await cache.get('sess-1', SessionCacheSchema);
        expect(before.flowMap).toEqual({});
        expect(before.transactionIds).toEqual([]);
        expect(await drain()).toEqual([]);

        // The participant's search arrives with ITS transaction id.
        await consumeExpectation(cache, 'tx-buyer');
        const got = await receiveLivePayload(
            deps,
            fromNp('search', 'm-search', { transaction_id: 'tx-buyer' }),
            NP
        );
        expect(got.kind).toBe('accepted');
        const sent = await drain();
        expect(sent.map(s => s.action)).toEqual(['on_search']);
        // The callback answers the request's message_id, on the buyer's transaction.
        expect(sent[0].payload.context.message_id).toBe('m-search');
        expect(sent[0].payload.context.transaction_id).toBe('tx-buyer');

        const after: any = await cache.get('sess-1', SessionCacheSchema);
        expect(after.flowMap).toEqual({ happy: 'tx-buyer' });
        const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer');
        expect(status.state.runs.map(r => r.nodeId)).toEqual([
            'search',
            'on_search',
        ]);
    });

    describe('step-through (v1 Experimental Mode, manual steps)', () => {
        it('sends one payload per click and holds its answer to the participant', async () => {
            const { deps, drain } = await setup('BPP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
                stepThrough: true,
            });
            // Starting is the click that sends search.
            const sent = await drain();
            expect(sent.map(s => s.action)).toEqual(['search']);

            // on_search is taken and ACKed, but the mock does not answer with select.
            const got = await receiveLivePayload(
                deps,
                fromNp('on_search', sent[0].payload.context.message_id),
                NP
            );
            expect(got.kind).toBe('accepted');
            expect(await drain()).toEqual([]);
            let status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status).toMatchObject({
                stepThrough: true,
                paused: 'select',
                plan: { kind: 'run', nodeId: 'select' },
            });
            expect(status.logs[status.logs.length - 1].message).toMatch(
                /Paused before select/
            );

            // Run step sends exactly that payload.
            const ran = await proceedLiveFlow(deps, {
                sessionId: 'sess-1',
                transactionId: 'tx-1',
            });
            expect(ran.success).toBe(true);
            expect((await drain()).map(s => s.action)).toEqual(['select']);
            status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status.paused).toBeNull();
            expect(status.plan).toMatchObject({
                kind: 'await',
                nodeId: 'on_select',
            });
        });

        it('carries on by itself once turned off while paused', async () => {
            const { deps, drain } = await setup('BPP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
                stepThrough: true,
            });
            const [search] = await drain();
            await receiveLivePayload(
                deps,
                fromNp('on_search', search.payload.context.message_id),
                NP
            );
            expect(await drain()).toEqual([]);

            const off = await proceedLiveFlow(deps, {
                sessionId: 'sess-1',
                transactionId: 'tx-1',
                stepThrough: false,
                settingsOnly: true,
            });
            expect(off.message).toMatch(/carries on/);
            expect((await drain()).map(s => s.action)).toEqual(['select']);
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status.stepThrough).toBe(false);
        });

        it('only saves the setting when not paused, and is off by default', async () => {
            const { deps, drain } = await setup('BPP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            await drain();
            expect(
                (await getLiveFlowStatus(deps, 'sess-1', 'tx-1')).stepThrough
            ).toBe(false);
            const on = await proceedLiveFlow(deps, {
                sessionId: 'sess-1',
                transactionId: 'tx-1',
                stepThrough: true,
                settingsOnly: true,
            });
            expect(on).toMatchObject({
                success: true,
                message: 'Settings saved',
            });
            expect(await drain()).toEqual([]);
            expect(
                (await getLiveFlowStatus(deps, 'sess-1', 'tx-1')).stepThrough
            ).toBe(true);
        });

        it('pauses a participant-opened journey before its first answer', async () => {
            const { deps, drain, cache } = await setup('BAP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                stepThrough: true,
            });
            await consumeExpectation(cache, 'tx-buyer');
            await receiveLivePayload(
                deps,
                fromNp('search', 'm-search', { transaction_id: 'tx-buyer' }),
                NP
            );
            expect(await drain()).toEqual([]);
            expect(
                (await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer')).paused
            ).toBe('on_search');
            await proceedLiveFlow(deps, {
                sessionId: 'sess-1',
                transactionId: 'tx-buyer',
            });
            const sent = await drain();
            expect(sent.map(s => s.action)).toEqual(['on_search']);
            expect(sent[0].payload.context.message_id).toBe('m-search');
        });
    });

    it('as BPP: starting the journey again re-arms the expectation and forgets the old run', async () => {
        const { deps, cache } = await setup('BAP');
        await startLiveFlow(deps, { sessionId: 'sess-1', journeyId: 'happy' });
        await consumeExpectation(cache, 'tx-old');
        await receiveLivePayload(
            deps,
            fromNp('search', 'm-1', { transaction_id: 'tx-old' }),
            NP
        );
        expect(
            ((await cache.get('sess-1', SessionCacheSchema)) as any).flowMap
        ).toEqual({ happy: 'tx-old' });

        // Started once more before (and after) the participant: no "already exists" failure.
        const again = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
        });
        expect(again.success).toBe(true);
        const twice = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
        });
        expect(twice.success).toBe(true);
        const expectations: any = await cache.get(NP, SessionCacheSchema);
        expect(expectations.activeSessions).toHaveLength(1);
        // The page waits for the new transaction instead of showing tx-old.
        expect(
            ((await cache.get('sess-1', SessionCacheSchema)) as any).flowMap
        ).toEqual({});
    });

    it('as BPP: refuses to listen while another session waits for the same action', async () => {
        const { deps, cache } = await setup('BAP');
        await cache.set(
            NP,
            {
                activeSessions: [
                    {
                        sessionId: 'other-session',
                        flowId: 'f',
                        expectedAction: 'search',
                        expireAt: new Date(Date.now() + 60_000).toISOString(),
                    },
                ],
            },
            SessionCacheSchema
        );
        const started = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
        });
        expect(started.success).toBe(false);
        expect(started.message).toMatch(/Cannot listen for search/);
    });

    it('keeps running after the api-service rewrites the session without `engine`', async () => {
        // ONIX re-marshals the session through its own struct when it maps a
        // transaction, dropping fields it does not know. The graph document decides.
        const { deps, drain, cache } = await setup('BAP');
        await startLiveFlow(deps, { sessionId: 'sess-1', journeyId: 'happy' });
        const session: any = await cache.get('sess-1', SessionCacheSchema);
        delete session.engine;
        await cache.set('sess-1', session, SessionCacheSchema);
        await consumeExpectation(cache, 'tx-buyer');

        const got = await receiveLivePayload(
            deps,
            fromNp('search', 'm-1', { transaction_id: 'tx-buyer' }),
            NP
        );
        expect(got.kind).toBe('accepted');
        expect((await drain()).map(s => s.action)).toEqual(['on_search']);
        const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer');
        expect(status.engine).toBe('graph-v2');
    });

    it('records what the api-service made of each payload the mock sent', async () => {
        const { deps, jobs, cache } = await setup('BPP');
        await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        // Run the advance, keep the send job to run it against fake api-service answers.
        while (jobs.length && jobs[0].name === STUDIO_LIVE_ADVANCE_JOB)
            await advanceLiveFlow(
                deps,
                jobs.shift()!.data as LiveAdvanceJobParams
            );
        const sendJob = jobs.find(j => j.name === STUDIO_LIVE_SEND_JOB)!
            .data as LiveSendJobParams;
        expect(sendJob.live).toEqual({
            transactionId: 'tx-1',
            subscriberUrl: NP,
            label: 'search (search)',
        });

        const answers = [
            {
                success: true,
                statusCode: 200,
                responseBody: { message: { ack: { status: 'ACK' } } },
            },
            {
                success: true,
                statusCode: 200,
                responseBody: {
                    message: { ack: { status: 'NACK' } },
                    error: { code: '30016', message: 'bad context' },
                },
            },
            {
                success: false,
                statusCode: 404,
                responseBody: '404 page not found',
            },
            undefined,
        ];
        for (const answer of answers)
            await createStudioLiveSendJobHandler(
                () => deps,
                async () => answer
            )(sendJob);
        await createStudioLiveSendJobHandler(
            () => deps,
            async () => {
                throw new Error('connect ECONNREFUSED');
            }
        )(sendJob);

        const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
        expect(status.deliveries.map(d => d.level)).toEqual([
            'success',
            'error',
            'error',
            'error',
            'error',
        ]);
        expect(status.deliveries[0].message).toBe(
            'search (search) delivered · ACK'
        );
        expect(status.deliveries[1].message).toMatch(
            /NACK · 30016: bad context/
        );
        expect(status.deliveries[2].message).toMatch(
            /HTTP 404 \(no route: is the api-service built for this domain and version\?\)/
        );
        expect(status.deliveries[3].message).toMatch(/could not be reached/);
        expect(status.deliveries[4].message).toMatch(/ECONNREFUSED/);
        // Merged into the run's log, in time order.
        expect(
            status.logs.filter(l => status.deliveries.includes(l as any))
        ).toHaveLength(5);
        expect(
            await cache.get(liveRunKey('tx-1', NP), SessionCacheSchema)
        ).not.toBeNull();
    });

    it('describes a 2xx without an ACK as a warning', () => {
        expect(
            describeDelivery('x', 'search', {
                success: true,
                statusCode: 202,
                responseBody: {},
            }).level
        ).toBe('warn');
    });

    it('rejects a payload the run does not expect, and answers an invalid one', async () => {
        const nodes = [
            LINEAR[0],
            node('on_search', 'on_search', {
                responseFor: 'search',
                code: { generate: GENERATE, validate: INVALID },
            }),
        ];
        const { deps, drain } = await setup('BPP', nodes);
        await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        await drain();

        const wrong = await receiveLivePayload(
            deps,
            fromNp('on_select', 'm1'),
            NP
        );
        expect(wrong).toMatchObject({ kind: 'rejected' });

        const invalid = await receiveLivePayload(
            deps,
            fromNp('on_search', 'm2'),
            NP
        );
        expect(invalid).toMatchObject({ kind: 'invalid', nodeId: 'on_search' });
        const sent = await drain();
        // v1's answer: an error callback on the mirrored action.
        expect(sent.map(s => s.action)).toEqual(['search']);
        expect(sent[0].payload.error).toEqual({
            code: '30016',
            message: 'bad item',
        });

        const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
        // Neither payload moved the run.
        expect(status.state.runs.map(r => r.nodeId)).toEqual(['search']);
        expect(status.rejected.map(r => r.action)).toEqual([
            'on_select',
            'on_search',
        ]);
    });

    it('takes a participant-started transaction from the api-service record', async () => {
        const { deps, drain, cache } = await setup('BAP');
        await cache.set(
            `tx-np::${NP}`,
            {
                sessionId: 'sess-1',
                flowId: 'happy',
                latestAction: 'search',
                latestTimestamp: '',
                subscriberType: 'BAP',
                messageIds: [],
                apiList: [],
            },
            TransactionCacheSchema
        );
        const got = await receiveLivePayload(
            deps,
            fromNp('search', 'm-1', { transaction_id: 'tx-np' }),
            NP
        );
        expect(got.kind).toBe('accepted');
        expect((await drain()).map(s => s.action)).toEqual(['on_search']);
        const session: any = await cache.get('sess-1', SessionCacheSchema);
        expect(session.flowMap).toEqual({ happy: 'tx-np' });
    });

    it("reports each payload's sync exchange from the api-service record", async () => {
        const { deps, drain, cache } = await setup('BPP');
        await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        const [search] = await drain();
        const messageId = search.payload.context.message_id;
        const nack = {
            message: { ack: { status: 'NACK' } },
            error: { code: '30000', message: 'no' },
        };
        await cache.set(
            `tx-1::${NP}`,
            {
                sessionId: 'sess-1',
                flowId: 'happy',
                latestAction: 'search',
                latestTimestamp: '',
                subscriberType: 'BPP',
                messageIds: [messageId],
                apiList: [
                    {
                        entryType: 'API',
                        action: 'search',
                        payloadId: 'p-1',
                        messageId,
                        response: nack,
                        timestamp: '2025-01-01T00:00:01.000Z',
                    },
                ],
            },
            TransactionCacheSchema
        );
        const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
        expect(status.acks).toEqual({ [`search::${messageId}`]: 'NACK' });
        expect(status.exchanges).toEqual({
            [`search::${messageId}`]: {
                payloadId: 'p-1',
                ack: 'NACK',
                response: nack,
                timestamp: '2025-01-01T00:00:01.000Z',
            },
        });
    });

    it('asks for inputs before running a step that has them', async () => {
        const nodes = [
            node('search', 'search', {
                inputs: {
                    jsonSchema: { type: 'object', properties: { city: {} } },
                },
            }),
            LINEAR[1],
        ];
        const { deps, drain } = await setup('BPP', nodes);
        const ask = await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        expect(ask.inputs).toMatchObject({ nodeId: 'search' });
        expect(await drain()).toEqual([]);

        const go = await proceedLiveFlow(deps, {
            sessionId: 'sess-1',
            transactionId: 'tx-1',
            inputs: { city: 'std:080' },
        });
        expect(go.jobIds).toHaveLength(1);
        const sent = await drain();
        expect(sent[0].payload.message.inputs).toEqual({ city: 'std:080' });
    });

    it('refuses to proceed while the flow is being processed', async () => {
        const { deps, drain } = await setup('BPP');
        await startLiveFlow(deps, {
            sessionId: 'sess-1',
            journeyId: 'happy',
            transactionId: 'tx-1',
        });
        await deps.workbench
            .FlowStatusCacheService()
            .setFlowStatus('tx-1', NP, 'WORKING');
        const busy = await proceedLiveFlow(deps, {
            sessionId: 'sess-1',
            transactionId: 'tx-1',
        });
        expect(busy).toMatchObject({ success: false });
        expect(busy.message).toMatch(/already being processed/);
        await drain();
    });
});
