import { setImmediate } from 'timers';
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
    EXECUTOR_TTL_MS,
    withRunLock,
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
const UNMET = b64(
    'function meetsRequirements(sessionData) { return { valid: false, code: 30001, description: "no provider" }; }'
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

type Graph = LiveGraphConfigV2['graph'];

/** `next` wires through the nodes in order. */
const chain = (nodes: GraphNodeV2[]): Graph['edges'] =>
    nodes.slice(1).map((n, i) => ({
        id: `e${i}`,
        from: nodes[i].id,
        to: n.id,
        kind: 'next' as const,
    }));

type DocShape = {
    /** Default: a chain through every node. */
    edges?: Graph['edges'];
    /** Default: one journey, `happy`, from the first node. */
    journeys?: LiveGraphConfigV2['journeys'];
};

const doc = (
    nodes: GraphNodeV2[],
    { edges, journeys }: DocShape = {}
): LiveGraphConfigV2 => ({
    kind: 'graph-v2-live',
    meta: { domain: 'ONDC:TRV14', version: '2.0.0', playground_version: 'v2' },
    transaction_data: {
        transaction_id: 'tx-config',
        latest_timestamp: '2025-01-01T00:00:00.000Z',
    },
    graph: { nodes, edges: edges ?? chain(nodes) },
    journeys: journeys ?? [
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

const setup = async (
    npType: 'BAP' | 'BPP',
    nodes: GraphNodeV2[] = LINEAR,
    shape: DocShape = {}
) => {
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
    await cache.set(
        liveConfigKey('sess-1'),
        doc(nodes, shape),
        SessionCacheSchema
    );
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

    describe('who opens a journey', () => {
        /** As BPP: the participant's search should open each of these journeys. */
        const opensWithParticipant = async (
            nodes: GraphNodeV2[],
            shape: DocShape,
            firstRuns: string[]
        ) => {
            const { deps, drain, cache } = await setup('BAP', nodes, shape);
            const started = await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-from-page',
            });
            // An expectation, and no transaction minted by the mock.
            expect(started).toMatchObject({
                success: true,
                awaiting: { nodeId: 'search', api: 'search' },
            });
            expect(started.transactionId).toBeUndefined();
            expect(
                await cache.get(
                    liveRunKey('tx-from-page', NP),
                    SessionCacheSchema
                )
            ).toBeNull();
            const expectations: any = await cache.get(NP, SessionCacheSchema);
            expect(expectations.activeSessions).toEqual([
                expect.objectContaining({ expectedAction: 'search' }),
            ]);

            // The participant's first request is the step the new run waits for.
            await consumeExpectation(cache, 'tx-buyer');
            const got = await receiveLivePayload(
                deps,
                fromNp('search', 'm-search', { transaction_id: 'tx-buyer' }),
                NP
            );
            expect(got).toMatchObject({ kind: 'accepted', nodeId: 'search' });
            expect((await drain()).map(s => s.action)).toEqual(['on_search']);
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer');
            expect(status.state.runs.map(r => r.nodeId)).toEqual([
                ...firstRuns,
                'search',
                'on_search',
            ]);
        };

        it('a journey that opens with a decision waits for the participant', async () => {
            const who: GraphNodeV2 = {
                id: 'who',
                api: 'decision',
                owner: 'BPP',
                kind: 'decision',
                cases: ['known', 'unknown'],
                code: {
                    decide: b64(
                        'function decide(sessionData) { return "known"; }'
                    ),
                },
            };
            await opensWithParticipant(
                [who, LINEAR[0], LINEAR[1]],
                {
                    edges: [
                        {
                            id: 'a',
                            from: 'who',
                            to: 'search',
                            kind: 'branch',
                            case: 'known',
                        },
                        {
                            id: 'b',
                            from: 'who',
                            to: 'on_search',
                            kind: 'branch',
                            case: 'unknown',
                        },
                        {
                            id: 'c',
                            from: 'search',
                            to: 'on_search',
                            kind: 'response',
                        },
                    ],
                    journeys: [
                        {
                            id: 'happy',
                            entry: 'who',
                            choices: {},
                            expects: { who: 'known' },
                            onDemand: [],
                        },
                    ],
                },
                ['who']
            );
        });

        it('a journey that skips its optional first step waits for the participant', async () => {
            // The mock (BPP) would send this, but the journey passes over it.
            const note = node('note', 'on_status', {
                kind: 'unsolicited',
                optional: true,
            });
            await opensWithParticipant(
                [note, LINEAR[0], LINEAR[1]],
                {
                    journeys: [
                        {
                            id: 'happy',
                            entry: 'note',
                            choices: {},
                            expects: {},
                            onDemand: [],
                            skips: ['note'],
                        },
                    ],
                },
                ['note']
            );
        });
    });

    describe('meetsRequirements', () => {
        const unmet = (id: string, api: string, patch = {}) =>
            node(id, api, {
                code: {
                    generate: GENERATE,
                    validate: VALID,
                    requirements: UNMET,
                },
                ...patch,
            });
        afterEach(() => {
            delete process.env.SKIP_MEETS_REQUIRMENTS;
        });

        /** As BPP, with on_search's requirements unmet: the participant's search arrives. */
        const searchArrives = async () => {
            const world = await setup('BAP', [
                LINEAR[0],
                unmet('on_search', 'on_search', { responseFor: 'search' }),
            ]);
            await startLiveFlow(world.deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
            });
            await consumeExpectation(world.cache, 'tx-buyer');
            await receiveLivePayload(
                world.deps,
                fromNp('search', 'm-search', { transaction_id: 'tx-buyer' }),
                NP
            );
            return world;
        };

        it('answers a callback whose requirements are unmet with REQUIREMENTS_NOT_MET, and fails the run', async () => {
            const { deps, drain } = await searchArrives();
            const sent = await drain();
            expect(sent.map(s => s.action)).toEqual(['on_search']);
            expect(sent[0].payload.context.message_id).toBe('m-search');
            expect(sent[0].payload.error).toMatchObject({
                code: 'REQUIREMENTS_NOT_MET',
                message: 'no provider',
            });
            expect(sent[0].payload.message).toBeUndefined();

            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer');
            expect(status.state.failure).toMatchObject({
                nodeId: 'on_search',
                cause: 'requirements',
            });
            expect(status.plan).toEqual({
                kind: 'stopped',
                reason: 'failure',
            });
            expect(status.logs.map(l => l.message)).toContainEqual(
                expect.stringMatching(
                    /The run failed at on_search · cause: requirements/
                )
            );
        });

        it('sends nothing for a request whose requirements are unmet', async () => {
            const { deps, drain } = await setup('BPP', [
                LINEAR[0],
                LINEAR[1],
                unmet('select', 'select'),
                LINEAR[3],
            ]);
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            const [search] = await drain();
            await receiveLivePayload(
                deps,
                fromNp('on_search', search.payload.context.message_id),
                NP
            );
            expect(await drain()).toEqual([]);
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status.state.failure).toMatchObject({
                nodeId: 'select',
                cause: 'requirements',
            });
        });

        it('is not run at all with SKIP_MEETS_REQUIRMENTS=true, as in v1', async () => {
            process.env.SKIP_MEETS_REQUIRMENTS = 'true';
            const { deps, drain } = await searchArrives();
            const sent = await drain();
            expect(sent.map(s => s.action)).toEqual(['on_search']);
            expect(sent[0].payload.error).toBeUndefined();
            expect(sent[0].payload.message).toEqual({ from: 'on_search' });
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-buyer');
            expect(status.state.failure).toBeNull();
        });
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

    describe('executor cache', () => {
        // Only the timers: the cache and the lib run on promises and immediates.
        const fakeTimers = () =>
            jest.useFakeTimers({
                doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
            });
        afterEach(() => {
            clearLiveExecutors();
            jest.useRealTimers();
        });

        /** Counts reads of the session's graph document; `hold` can delay one. */
        const watchDocReads = (
            cache: ICacheService,
            hold?: (read: number) => Promise<unknown> | undefined
        ) => {
            let reads = 0;
            const get = cache.get.bind(cache);
            cache.get = (async (key: string, schema: never) => {
                if (key === liveConfigKey('sess-1')) {
                    reads += 1;
                    const held = hold?.(reads);
                    if (held) return held;
                }
                return get(key, schema);
            }) as ICacheService['get'];
            return () => reads;
        };
        const flush = () => new Promise(resolve => setImmediate(resolve));

        it('evicts a session’s executor after its TTL, so the document is read again', async () => {
            fakeTimers();
            // The participant opens the journey: starting it only builds the executor.
            const { deps, cache } = await setup('BAP');
            const reads = watchDocReads(cache);
            const start = () =>
                startLiveFlow(deps, {
                    sessionId: 'sess-1',
                    journeyId: 'happy',
                });

            await start();
            await start();
            expect(reads()).toBe(1);
            jest.advanceTimersByTime(EXECUTOR_TTL_MS - 1);
            await start();
            expect(reads()).toBe(1);
            jest.advanceTimersByTime(1);
            await start();
            expect(reads()).toBe(2);

            // One timer per cached executor, and clearing drops it.
            expect(jest.getTimerCount()).toBe(1);
            clearLiveExecutors();
            expect(jest.getTimerCount()).toBe(0);
        });

        it('drops a failed build, but not a newer one built after an eviction', async () => {
            fakeTimers();
            const { deps, cache } = await setup('BAP');
            let missing!: (value: null) => void;
            // The first read hangs, then finds no document: that build fails.
            const reads = watchDocReads(cache, read =>
                read === 1
                    ? new Promise<null>(resolve => (missing = resolve))
                    : undefined
            );
            const start = () =>
                startLiveFlow(deps, {
                    sessionId: 'sess-1',
                    journeyId: 'happy',
                });

            const first = start();
            while (reads() < 1) await flush();
            // Evicted while still building; the next start builds again and succeeds.
            jest.advanceTimersByTime(EXECUTOR_TTL_MS);
            expect((await start()).success).toBe(true);
            expect(reads()).toBe(2);

            missing(null);
            await expect(first).rejects.toThrow(/No live graph document/);
            // The failed build did not take the newer executor with it.
            await start();
            expect(reads()).toBe(2);
        });
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

    describe('one writer per run', () => {
        const RUN = liveRunKey('tx-1', NP);
        const FLOW_STATUS = `FLOW_STATUS_tx-1::${NP}`;
        /** The participant (BPP) may send on_status at any point. */
        const ON_STATUS = node('on_status', 'on_status', { kind: 'on_demand' });
        const WITH_STATUS = { edges: chain(LINEAR) };

        /**
         * Counts cache calls per key, and holds a chosen one until released: a write
         * is held before it writes, a read after it read (it then returns what it
         * read). That is how each test parks one writer mid-update.
         */
        const watchCache = (cache: ICacheService) => {
            const counts = new Map<string, number>();
            const holds: {
                id: string;
                nth: number;
                gate: Promise<void>;
                reached: () => void;
            }[] = [];
            for (const method of ['get', 'set'] as const) {
                const original = cache[method].bind(cache) as (
                    key: string,
                    ...rest: unknown[]
                ) => Promise<unknown>;
                (cache as unknown as Record<string, unknown>)[method] = async (
                    key: string,
                    ...rest: unknown[]
                ) => {
                    const id = `${method} ${key}`;
                    const n = (counts.get(id) ?? 0) + 1;
                    counts.set(id, n);
                    const hold = holds.find(h => h.id === id && h.nth === n);
                    if (!hold) return original(key, ...rest);
                    hold.reached();
                    if (method === 'get') {
                        const value = await original(key, ...rest);
                        await hold.gate;
                        return value;
                    }
                    await hold.gate;
                    return original(key, ...rest);
                };
            }
            return {
                calls: (method: 'get' | 'set', key: string) =>
                    counts.get(`${method} ${key}`) ?? 0,
                /** Holds the `nth` call from now of `method` on `key`. */
                hold(method: 'get' | 'set', key: string, nth = 1) {
                    const id = `${method} ${key}`;
                    let release!: () => void;
                    let reached!: () => void;
                    const gate = new Promise<void>(r => (release = r));
                    const arrived = new Promise<void>(r => (reached = r));
                    holds.push({
                        id,
                        nth: (counts.get(id) ?? 0) + nth,
                        gate,
                        reached,
                    });
                    return { reached: arrived, release };
                },
            };
        };

        /**
         * Lets other work run until `done()`, or for `ms` at most: the time a racing
         * call gets to overtake the held one when nothing stops it.
         */
        const runUntil = async (done: () => boolean, ms = 250) => {
            const end = Date.now() + ms;
            while (!done() && Date.now() < end)
                await new Promise(resolve => setTimeout(resolve, 5));
        };

        const flowStatusOf = async (deps: LiveDeps) =>
            (
                await deps.workbench
                    .FlowStatusCacheService()
                    .getFlowStatus('tx-1', NP, {})
            ).status;

        it('serialises per key, lets other keys through, and is released by a throw', async () => {
            const order: string[] = [];
            let release!: () => void;
            const gate = new Promise<void>(r => (release = r));
            const a = withRunLock('k', async () => {
                order.push('a');
                await gate;
                throw new Error('a failed');
            });
            const b = withRunLock('k', async () => order.push('b'));
            await withRunLock('other', async () => order.push('other'));
            expect(order).toEqual(['a', 'other']);
            release();
            await expect(a).rejects.toThrow('a failed');
            await b;
            expect(order).toEqual(['a', 'other', 'b']);
        });

        it('keeps both steps when two payloads arrive together', async () => {
            const { deps, drain, cache } = await setup(
                'BPP',
                [...LINEAR, ON_STATUS],
                WITH_STATUS
            );
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            const [search] = await drain();
            const watch = watchCache(cache);

            // The first payload's save is held; the second arrives meanwhile.
            const held = watch.hold('set', RUN);
            const first = receiveLivePayload(
                deps,
                fromNp('on_search', search.payload.context.message_id),
                NP
            );
            await held.reached;
            const reads = watch.calls('get', RUN);
            const second = receiveLivePayload(
                deps,
                fromNp('on_status', 'm-status'),
                NP
            );
            // Unlocked, the second reads the run (findLiveRun, then to update it).
            await runUntil(() => watch.calls('get', RUN) >= reads + 2);
            held.release();

            expect(await first).toMatchObject({
                kind: 'accepted',
                nodeId: 'on_search',
            });
            expect(await second).toMatchObject({
                kind: 'accepted',
                nodeId: 'on_status',
            });
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status.state.runs.map(r => r.nodeId)).toEqual([
                'search',
                'on_search',
                'on_status',
            ]);
        });

        it('keeps a payload that arrives while an advance runs', async () => {
            const { deps, drain, jobs, cache } = await setup(
                'BPP',
                [...LINEAR, ON_STATUS],
                WITH_STATUS
            );
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            const [search] = await drain();
            await receiveLivePayload(
                deps,
                fromNp('on_search', search.payload.context.message_id),
                NP
            );
            // The advance that answers on_search with select: its save is held.
            const advance = jobs.shift()!;
            expect(advance.name).toBe(STUDIO_LIVE_ADVANCE_JOB);
            const watch = watchCache(cache);
            const held = watch.hold('set', RUN);
            const advancing = advanceLiveFlow(
                deps,
                advance.data as LiveAdvanceJobParams
            );
            await held.reached;
            const reads = watch.calls('get', RUN);
            const receiving = receiveLivePayload(
                deps,
                fromNp('on_status', 'm-status'),
                NP
            );
            await runUntil(() => watch.calls('get', RUN) >= reads + 2);
            held.release();

            expect(await advancing).toMatchObject({ sent: 1 });
            expect(await receiving).toMatchObject({
                kind: 'accepted',
                nodeId: 'on_status',
            });
            const status = await getLiveFlowStatus(deps, 'sess-1', 'tx-1');
            expect(status.state.runs.map(r => r.nodeId)).toEqual([
                'search',
                'on_search',
                'select',
                'on_status',
            ]);
            expect(
                jobs
                    .filter(j => j.name === STUDIO_LIVE_SEND_JOB)
                    .map(j => (j.data as LiveSendJobParams).action)
            ).toEqual(['select']);
        });

        /** Step-through, paused before select: a Run step click queues one advance. */
        const pausedBeforeSelect = async () => {
            const world = await setup('BPP');
            await startLiveFlow(world.deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
                stepThrough: true,
            });
            const [search] = await world.drain();
            await receiveLivePayload(
                world.deps,
                fromNp('on_search', search.payload.context.message_id),
                NP
            );
            expect(await world.drain()).toEqual([]);
            expect(
                (await getLiveFlowStatus(world.deps, 'sess-1', 'tx-1')).paused
            ).toBe('select');
            return world;
        };
        const runStep = (deps: LiveDeps) =>
            proceedLiveFlow(deps, {
                sessionId: 'sess-1',
                transactionId: 'tx-1',
            });

        it('queues one advance for a double click', async () => {
            const { deps, jobs, cache } = await pausedBeforeSelect();
            const watch = watchCache(cache);
            // The first click's check under the lock (its second status read) is held.
            const held = watch.hold('get', FLOW_STATUS, 2);
            const first = runStep(deps);
            await held.reached;
            let secondDone = false;
            const second = runStep(deps).finally(() => (secondDone = true));
            // Unlocked, the second click claims the flow and queues its advance meanwhile.
            await runUntil(() => secondDone);
            held.release();

            const answers = await Promise.all([first, second]);
            expect(answers[0]).toMatchObject({
                success: true,
                message: 'Proceeding',
            });
            expect(answers[1]).toMatchObject({
                success: false,
                message: expect.stringMatching(/already being processed/),
            });
            expect(
                jobs.filter(j => j.name === STUDIO_LIVE_ADVANCE_JOB)
            ).toHaveLength(1);
        });

        it('claims the flow before queueing the advance, and frees it when queueing fails', async () => {
            const { deps, jobs } = await pausedBeforeSelect();
            const enqueue = deps.queue.enqueue;
            let during: string | undefined;
            deps.queue.enqueue = async () => {
                during = await flowStatusOf(deps);
                throw new Error('queue is down');
            };
            await expect(runStep(deps)).rejects.toThrow('queue is down');
            expect(during).toBe('WORKING');
            expect(await flowStatusOf(deps)).toBe('AVAILABLE');

            // Not stuck: the next click goes through.
            deps.queue.enqueue = enqueue;
            expect(await runStep(deps)).toMatchObject({ success: true });
            expect(await flowStatusOf(deps)).toBe('WORKING');
            expect(jobs.map(j => j.name)).toEqual([STUDIO_LIVE_ADVANCE_JOB]);
        });

        it('sends nothing when the advance cannot save the run', async () => {
            const { deps, jobs, cache } = await setup('BPP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            const advance = jobs.shift()!;
            const set = cache.set.bind(cache);
            cache.set = (async (key: string, ...rest: never[]) => {
                if (key === RUN) throw new Error('redis is down');
                return (set as (...args: unknown[]) => Promise<void>)(
                    key,
                    ...rest
                );
            }) as ICacheService['set'];
            await expect(
                advanceLiveFlow(deps, advance.data as LiveAdvanceJobParams)
            ).rejects.toThrow('redis is down');
            expect(jobs).toEqual([]);
            expect(await flowStatusOf(deps)).toBe('AVAILABLE');
        });

        it('queues payloads after the run is saved and the lock is free', async () => {
            const { deps, jobs } = await setup('BPP');
            await startLiveFlow(deps, {
                sessionId: 'sess-1',
                journeyId: 'happy',
                transactionId: 'tx-1',
            });
            const advance = jobs.shift()!;
            // A queue may run work inside enqueue (the e2e engine driver does): here the
            // participant answers search, and the tester clicks, before enqueue returns.
            const enqueue = deps.queue.enqueue;
            const inside: unknown[] = [];
            deps.queue.enqueue = async (name, data, options) => {
                if (name === STUDIO_LIVE_SEND_JOB && inside.length === 0) {
                    const sent = data as LiveSendJobParams;
                    const context = (
                        sent.payload as { context: { message_id: string } }
                    ).context;
                    inside.push(
                        await receiveLivePayload(
                            deps,
                            fromNp('on_search', context.message_id),
                            NP
                        )
                    );
                    inside.push(await runStep(deps));
                }
                return enqueue(name, data, options);
            };
            expect(
                await advanceLiveFlow(
                    deps,
                    advance.data as LiveAdvanceJobParams
                )
            ).toMatchObject({ sent: 1 });
            // The run already had search, and the flow was still being processed.
            expect(inside[0]).toMatchObject({
                kind: 'accepted',
                nodeId: 'on_search',
            });
            expect(inside[1]).toMatchObject({
                success: false,
                message: expect.stringMatching(/already being processed/),
            });
        });
    });
});
