import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
    createGraphRunV2,
    finishV2,
    getRunStatusV2,
    GraphExecutorV2,
    LiveGraphConfigV2Schema,
    planV2,
    receiveV2,
    settleV2,
    stepV2,
    triggerV2,
    type DriverLogV2,
    type GraphNodeV2,
    type GraphPlanV2,
    type GraphRunStateV2,
    type JourneyV2,
    type LiveGraphConfigV2,
    type PlaysV2,
    type RecogniseResultV2,
    type StepRunV2,
} from '@ondc/automation-mock-runner';

import { ICacheService } from '../../cache/cache-interface';
import { IQueueService } from '../../queue/IQueueService';
import { SessionCache, SessionCacheSchema } from '../../types/cache-types';
import logger from '../../utils/logger';
import { resolveApiServiceUrls } from '../cache/config-cache';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import {
    ApiServiceRequestJobParams,
    ApiServiceRequestJobResult,
    createApiServiceRequestJobHandler,
} from '../jobs/api-service-request';

/**
 * Live sessions of a Protocol Studio graph (`session.engine === "graph-v2"`).
 *
 * The rules of the run are the lib's graph driver — the same code the Studio
 * simulation runs — so this module only does I/O: it loads the graph document
 * Studio stored (`PLAYGROUND_V2_<sessionId>`), keeps each transaction's run in
 * `LIVE_V2::<txn>::<subscriberUrl>`, sends what the mock generates through the
 * api-service exactly as v1 does, and feeds the participant's payloads back to
 * the driver. The mock plays the side opposite the participant (`npType`).
 * v1 sessions never reach this module.
 */

export const STUDIO_LIVE_ADVANCE_JOB = 'STUDIO_LIVE_ADVANCE_JOB';

/** How many steps one advance may take before it stops (a cycle with no repeat cap). */
const ADVANCE_LIMIT = 50;
/** How long a session's executor is kept before the document is read again. */
export const EXECUTOR_TTL_MS = 5 * 60 * 1000;
const RUN_TTL_SECONDS = 60 * 60 * 5;
const LOG_LIMIT = 200;

export type LiveDeps = {
    /** DB 0, the workbench cache: sessions, the graph document, run records. */
    cache: ICacheService;
    workbench: WorkbenchCacheServiceType;
    queue: IQueueService;
};

export const isGraphV2Session = (session: unknown): boolean =>
    (session as { engine?: unknown } | null)?.engine === 'graph-v2';

export const liveConfigKey = (sessionId: string) =>
    `PLAYGROUND_V2_${sessionId}`;

/**
 * Whether a session runs on a Studio graph. `engine: 'graph-v2'` cannot be relied on
 * alone: the api-service rewrites the session through its own struct whenever it
 * maps a transaction (expectation consumed, first call recorded) and drops fields it
 * does not know, `engine` among them. The session would then fall through to the v1
 * engine mid-run. The graph document it was created with is never touched, so its
 * presence decides.
 */
export const isLiveSession = async (
    deps: Pick<LiveDeps, 'cache'>,
    sessionId: string,
    session?: unknown
): Promise<boolean> =>
    isGraphV2Session(session) ||
    (await deps.cache.exists(liveConfigKey(sessionId)).catch(() => false));
export const liveRunKey = (transactionId: string, subscriberUrl: string) =>
    `LIVE_V2::${transactionId.trim()}::${subscriberUrl.trim()}`;
/** What the api-service made of each payload the mock sent on a run (see STUDIO_LIVE_SEND_JOB). */
export const liveDeliveryKey = (transactionId: string, subscriberUrl: string) =>
    `LIVE_V2_DELIVERY::${transactionId.trim()}::${subscriberUrl.trim()}`;

/** A payload from the participant that was not taken. */
/**
 * The tester's settings for a session's live runs, kept by the mock: the api-service
 * rewrites the session JSON through its own struct and drops fields it does not know,
 * and a participant-opened journey has no run record until its first request.
 */
export const liveSettingsKey = (sessionId: string) =>
    `LIVE_V2_SETTINGS::${sessionId}`;

export type LiveSettings = {
    /**
     * Step through: the mock sends one payload per click (start, Run step, inputs)
     * instead of running on to the next wait. v1's Experimental Mode "manual" steps.
     */
    stepThrough: boolean;
};

const LiveSettingsSchema = z.looseObject({
    stepThrough: z.boolean(),
}) as unknown as z.ZodType<LiveSettings>;

/** As long as the session itself lasts. */
const SETTINGS_TTL_SECONDS = 60 * 60 * 24 * 4;

export const getLiveSettings = async (
    deps: LiveDeps,
    sessionId: string
): Promise<LiveSettings> =>
    (await deps.cache
        .get(liveSettingsKey(sessionId), LiveSettingsSchema)
        .catch(() => null)) ?? { stepThrough: false };

const saveLiveSettings = (
    deps: LiveDeps,
    sessionId: string,
    settings: LiveSettings
) =>
    deps.cache.set(
        liveSettingsKey(sessionId),
        settings,
        LiveSettingsSchema,
        SETTINGS_TTL_SECONDS
    );

/** A node whose run sends a payload to the participant: what step-through pauses before. */
const sendsPayload = (node: GraphNodeV2) =>
    node.kind === 'request' ||
    node.kind === 'callback' ||
    node.kind === 'unsolicited' ||
    node.kind === 'on_demand';

export type RejectedPayloadV2 = {
    ts: string;
    action?: string;
    messageId?: string;
    reason: string;
    payload: unknown;
};

export type LiveRunRecord = {
    sessionId: string;
    journeyId: string;
    transactionId: string;
    subscriberUrl: string;
    state: GraphRunStateV2;
    rejected: RejectedPayloadV2[];
    logs: (DriverLogV2 & { ts: string })[];
    updatedAt: string;
};

const LiveRunRecordSchema = z.looseObject({
    sessionId: z.string(),
    journeyId: z.string(),
    transactionId: z.string(),
    subscriberUrl: z.string(),
    state: z.looseObject({
        session: z.looseObject({ events: z.array(z.any()) }),
        runs: z.array(z.any()),
    }),
    rejected: z.array(z.any()),
    logs: z.array(z.any()),
    updatedAt: z.string(),
}) as unknown as z.ZodType<LiveRunRecord>;

export type LiveActionResult = {
    success: boolean;
    message: string;
    transactionId?: string;
    jobIds?: string[];
    /** The step waits for tester inputs: its node and JSON schema. */
    inputs?: { nodeId: string; schema: unknown; extra?: boolean };
    /**
     * The participant opens the journey: no transaction exists until its first
     * request arrives (then the session's flowMap names it).
     */
    awaiting?: { nodeId: string; api: string };
};

type Loaded = {
    doc: LiveGraphConfigV2;
    executor: GraphExecutorV2;
    session: SessionCache;
    plays: PlaysV2;
};

/**
 * Each session's executor, built once from its graph document and evicted
 * EXECUTOR_TTL_MS later (v1's runner cache does the same, service/cache/config-cache.ts):
 * the next load reads the document again, and a session nobody runs any more
 * stops holding its graph in memory.
 */
const executors = new Map<
    string,
    { promise: Promise<Omit<Loaded, 'session'>> }
>();
const executorTimers = new Map<string, NodeJS.Timeout>();

const cacheExecutor = (
    sessionId: string,
    promise: Promise<Omit<Loaded, 'session'>>
) => {
    const existing = executorTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    executors.set(sessionId, { promise });
    const timer = setTimeout(() => {
        executors.delete(sessionId);
        executorTimers.delete(sessionId);
    }, EXECUTOR_TTL_MS);
    timer.unref();
    executorTimers.set(sessionId, timer);
};

/** Drops a session's executor, but only if it is still the one built by `promise`. */
const dropExecutor = (
    sessionId: string,
    promise: Promise<Omit<Loaded, 'session'>>
) => {
    if (executors.get(sessionId)?.promise !== promise) return;
    clearTimeout(executorTimers.get(sessionId));
    executorTimers.delete(sessionId);
    executors.delete(sessionId);
};

/** Drops cached executors (tests; a session whose document changed). */
export const clearLiveExecutors = () => {
    for (const timer of executorTimers.values()) clearTimeout(timer);
    executorTimers.clear();
    executors.clear();
};

const getSession = async (deps: LiveDeps, sessionId: string) =>
    deps.workbench.NpSessionalCacheService().getSessionData(sessionId);

/** The side the mock plays: the one the participant does not. */
export const mockPlays = (npType: 'BAP' | 'BPP'): PlaysV2 =>
    npType === 'BAP' ? 'BPP' : 'BAP';

const buildExecutor = async (
    deps: LiveDeps,
    sessionId: string,
    session: SessionCache
): Promise<Omit<Loaded, 'session'>> => {
    const doc = (await deps.cache.get(
        liveConfigKey(sessionId),
        LiveGraphConfigV2Schema
    )) as LiveGraphConfigV2 | null;
    if (!doc)
        throw new Error(
            `No live graph document for session ${sessionId} (${liveConfigKey(sessionId)})`
        );
    // As for v1 configs: the mock's ids and uris are the api-service's.
    const { url: apiServiceUrl, ownerId } = resolveApiServiceUrls();
    const { domain, version } = doc.meta;
    const transactionData = {
        ...doc.transaction_data,
        bap_id: ownerId,
        bpp_id: ownerId,
        bap_uri: `${apiServiceUrl}/${domain}/${version}/buyer`,
        bpp_uri: `${apiServiceUrl}/${domain}/${version}/seller`,
    };
    // What v1 puts into MOCK_DATA and the generate job's session data.
    const externalSessionData: Record<string, unknown> = {
        ...(doc.transaction_data.external_session_data ?? {}),
        sessionId,
        subscriberUrl: session.subscriberUrl,
        mockBaseUrl: process.env.BASE_URL || null,
        [session.npType === 'BAP' ? 'bapUri' : 'bppUri']: session.subscriberUrl,
        ...(process.env.FINVU_AA_SERVICE_URL
            ? { finvuUrl: process.env.FINVU_AA_SERVICE_URL }
            : {}),
    };
    const executor = new GraphExecutorV2(doc.graph, {
        domain,
        version,
        transactionData,
        ...(doc.helperLib ? { helperLib: doc.helperLib } : {}),
        externalSessionData,
    });
    return { doc, executor, plays: mockPlays(session.npType) };
};

const load = async (deps: LiveDeps, sessionId: string): Promise<Loaded> => {
    const session = await getSession(deps, sessionId);
    if (!(await isLiveSession(deps, sessionId, session)))
        throw new Error(`Session ${sessionId} is not a graph-v2 live session`);
    let promise = executors.get(sessionId)?.promise;
    if (!promise) {
        const built = buildExecutor(deps, sessionId, session);
        cacheExecutor(sessionId, built);
        // A failed build is not kept, but a newer one (after an eviction) is left alone.
        built.catch(() => dropExecutor(sessionId, built));
        promise = built;
    }
    return { ...(await promise), session };
};

const journeyOf = (doc: LiveGraphConfigV2, journeyId: string): JourneyV2 => {
    const journey = doc.journeys.find(j => j.id === journeyId);
    if (!journey)
        throw new Error(`Journey ${journeyId} is not in this live session`);
    return journey;
};

const runLocks = new Map<string, Promise<void>>();

/**
 * One writer per run. Each entry point that reads a run record, changes it and
 * writes it back (start, proceed, the advance job, a participant's payload) does
 * so under this lock, keyed by the record's key (`liveRunKey`). Without it, two of
 * them that read the same record each write back their own copy, and the steps the
 * first one added are lost.
 *
 * In-process: a promise chain per key, enough while the mock runs as a single
 * instance. Several instances would need a shared lock in ICacheService (Redis
 * `SET key token NX PX ttl`, released by its token).
 *
 * Not re-entrant, so it is taken only at those entry points, never inside one.
 * Nothing is enqueued while it is held either: a queue may run other work inside
 * `enqueue` (the e2e engine driver runs test hooks there that call proceed), and
 * the job itself takes the lock.
 */
export const withRunLock = async <T>(
    key: string,
    fn: () => Promise<T>
): Promise<T> => {
    const previous = runLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const tail = previous.then(() => held);
    runLocks.set(key, tail);
    try {
        await previous;
        return await fn();
    } finally {
        release();
        if (runLocks.get(key) === tail) runLocks.delete(key);
    }
};

const getRecord = (
    deps: LiveDeps,
    transactionId: string,
    subscriberUrl: string
) =>
    deps.cache.get(
        liveRunKey(transactionId, subscriberUrl),
        LiveRunRecordSchema
    );

const saveRecord = (deps: LiveDeps, record: LiveRunRecord) =>
    deps.cache.set(
        liveRunKey(record.transactionId, record.subscriberUrl),
        { ...record, updatedAt: new Date().toISOString() },
        LiveRunRecordSchema,
        RUN_TTL_SECONDS
    );

const withLogs = (
    record: LiveRunRecord,
    logs: DriverLogV2[]
): LiveRunRecord => {
    const ts = new Date().toISOString();
    return {
        ...record,
        logs: [...record.logs, ...logs.map(l => ({ ...l, ts }))].slice(
            -LOG_LIMIT
        ),
    };
};

/** A node without its code: what a stored recognition needs to name it. */
const slimNode = (node: GraphNodeV2): GraphNodeV2 => ({
    id: node.id,
    api: node.api,
    owner: node.owner,
    kind: node.kind,
});
const slimRecognition = (r: RecogniseResultV2): RecogniseResultV2 => ({
    ...r,
    node: r.node ? slimNode(r.node) : null,
    matched: r.matched.map(slimNode),
    candidates: r.candidates.map(slimNode),
});

/** A plan as the live page reads it: node ids, not whole nodes. */
export const summarisePlan = (plan: GraphPlanV2) => {
    switch (plan.kind) {
        case 'run':
        case 'skip':
        case 'form':
            return { kind: plan.kind, nodeId: plan.node.id };
        case 'inputs':
            return {
                kind: plan.kind,
                nodeId: plan.node.id,
                schema: plan.schema,
            };
        case 'await':
            return {
                kind: plan.kind,
                nodeId: plan.node.id,
                candidates: plan.candidates.map(n => n.id),
            };
        case 'fork':
            return {
                kind: plan.kind,
                nodeId: plan.fork.nodeId,
                options: plan.fork.options.map(o => o.target.id),
            };
        default:
            return plan;
    }
};

/** Records the transaction on the session like the api-service does for v1 flows. */
const markFlowOnSession = async (
    deps: LiveDeps,
    sessionId: string,
    journeyId: string,
    transactionId: string
) => {
    const session = await getSession(deps, sessionId);
    const transactionIds = session.transactionIds.includes(transactionId)
        ? session.transactionIds
        : [...session.transactionIds, transactionId];
    await deps.cache.set(
        sessionId,
        {
            ...session,
            transactionIds,
            flowMap: { ...session.flowMap, [journeyId]: transactionId },
        },
        SessionCacheSchema
    );
};

const enqueueAdvance = async (
    deps: LiveDeps,
    data: LiveAdvanceJobParams
): Promise<string> => deps.queue.enqueue(STUDIO_LIVE_ADVANCE_JOB, data);

/** What a run waits for, as a v1-shaped answer to new / proceed. */
const answerFor = (
    plan: GraphPlanV2,
    transactionId: string
): LiveActionResult | null => {
    switch (plan.kind) {
        case 'inputs':
            return {
                success: true,
                message: `${plan.node.id} needs inputs`,
                transactionId,
                inputs: { nodeId: plan.node.id, schema: plan.schema },
            };
        case 'form':
            return {
                success: true,
                message: `${plan.node.id} waits for its form submission`,
                transactionId,
            };
        case 'await':
            return {
                success: true,
                message: `Listening for ${plan.node.api} (${plan.node.id}) from the participant`,
                transactionId,
            };
        case 'end':
            return {
                success: true,
                message: 'No further action',
                transactionId,
            };
        case 'stopped':
            return {
                success: false,
                message: `The run has stopped (${plan.reason})`,
                transactionId,
            };
        case 'fork':
            return {
                success: false,
                message: `A fork at ${plan.fork.nodeId} has no choice in this journey`,
                transactionId,
            };
        default:
            return null;
    }
};

/**
 * Forgets the journey's previous transaction on the session (v1's clearFlow), so the
 * page waits for the participant's new one instead of showing the old run.
 */
const unmarkFlowOnSession = async (
    deps: LiveDeps,
    sessionId: string,
    journeyId: string
) => {
    const session = await getSession(deps, sessionId);
    if (!(journeyId in session.flowMap)) return;
    const flowMap = { ...session.flowMap };
    delete flowMap[journeyId];
    await deps.cache.set(
        sessionId,
        { ...session, flowMap },
        SessionCacheSchema
    );
};

/**
 * The participant opens the journey, so the transaction is theirs: its id arrives
 * with their first request, and nothing can be stored under it before then. As v1
 * does, only an expectation is armed. The api-service consumes it on that request,
 * writes the transaction record and the session's flowMap under the participant's
 * id, and `receiveLivePayload` starts the run from that record.
 */
const awaitParticipant = async (
    deps: LiveDeps,
    sessionId: string,
    journeyId: string,
    subscriberUrl: string,
    node: GraphNodeV2
): Promise<LiveActionResult> => {
    const subscribers = deps.workbench.SubscriberCacheService();
    // Starting the journey again re-arms this session's expectation.
    const armed = await subscribers
        .getSubscriberData(subscriberUrl)
        .catch(() => null);
    if (armed?.activeSessions.some(e => e.sessionId === sessionId))
        await subscribers.deleteExpectation(sessionId, subscriberUrl);
    try {
        await subscribers.createExpectation(
            subscriberUrl,
            journeyId,
            sessionId,
            node.api
        );
    } catch (error) {
        // Another session already waits for this action on the same URL (v1's flowPermission).
        return {
            success: false,
            message: `Cannot listen for ${node.api}: ${(error as Error).message}. Stop the other session's flow first.`,
        };
    }
    await unmarkFlowOnSession(deps, sessionId, journeyId);
    return {
        success: true,
        message: `Listening for ${node.api} (${node.id}) from the participant · the run starts under the transaction_id it sends`,
        awaiting: { nodeId: node.id, api: node.api },
    };
};

/** `POST /flows/new` for a graph-v2 session: one journey, one transaction. */
export const startLiveFlow = async (
    deps: LiveDeps,
    {
        sessionId,
        journeyId,
        transactionId: requested,
        inputs,
        stepThrough,
    }: {
        sessionId: string;
        journeyId: string;
        transactionId?: string;
        inputs?: Record<string, unknown>;
        /** The tester's step-through setting, saved for the session's runs. */
        stepThrough?: boolean;
    }
): Promise<LiveActionResult> => {
    const { doc, executor, session, plays } = await load(deps, sessionId);
    const journey = journeyOf(doc, journeyId);
    if (stepThrough !== undefined)
        await saveLiveSettings(deps, sessionId, { stepThrough });
    const subscriberUrl = session.subscriberUrl;

    // Who opens the journey decides who owns its transaction_id. Settle a throwaway
    // run first, past the journey's skips and the decisions (nobody sends those), and
    // see what it does next; nothing is stored until that is known.
    const { plan: opening } = await settleV2(
        executor,
        createGraphRunV2(executor, { transactionId: 'unassigned', journey }),
        journey,
        { plays }
    );
    if (opening.kind === 'await')
        return awaitParticipant(
            deps,
            sessionId,
            journeyId,
            subscriberUrl,
            opening.node
        );

    // The mock opens the journey: the transaction is the mock's to mint.
    const transactionId = requested ?? randomUUID();
    const answer = await withRunLock(
        liveRunKey(transactionId, subscriberUrl),
        async () => {
            const record: LiveRunRecord = {
                sessionId,
                journeyId,
                transactionId,
                subscriberUrl,
                state: createGraphRunV2(executor, { transactionId, journey }),
                rejected: [],
                logs: [
                    {
                        level: 'info',
                        message: `Live run started · ${journey.title ?? journey.id} · tx ${transactionId} · mock plays ${plays}`,
                        ts: new Date().toISOString(),
                    },
                ],
                updatedAt: new Date().toISOString(),
            };
            await saveRecord(deps, record);
            await markFlowOnSession(deps, sessionId, journeyId, transactionId);

            const plan = planV2(executor, record.state, journey, plays);
            if (plan.kind === 'inputs' && inputs !== undefined) return null;
            return answerFor(plan, transactionId);
        }
    );
    if (answer) return answer;
    // Outside the lock: the advance takes it.
    const jobId = await enqueueAdvance(deps, {
        sessionId,
        transactionId,
        subscriberUrl,
        ...(inputs !== undefined ? { inputs } : {}),
    });
    return {
        success: true,
        message: 'Flow started',
        transactionId,
        jobIds: [jobId],
    };
};

/** `POST /flows/proceed` for a graph-v2 session. */
export const proceedLiveFlow = async (
    deps: LiveDeps,
    {
        sessionId,
        transactionId,
        inputs,
        formData,
        triggerExtra,
        finish,
        stepThrough,
        settingsOnly,
    }: {
        sessionId: string;
        transactionId: string;
        inputs?: Record<string, unknown>;
        formData?: Record<string, unknown>;
        triggerExtra?: string;
        finish?: boolean;
        /** The tester's step-through setting, saved for the session's runs. */
        stepThrough?: boolean;
        /** Only save the settings; the run moves on only if step-through was turned off. */
        settingsOnly?: boolean;
    }
): Promise<LiveActionResult> => {
    const { doc, executor, session, plays } = await load(deps, sessionId);
    const subscriberUrl = session.subscriberUrl;
    if (stepThrough !== undefined)
        await saveLiveSettings(deps, sessionId, { stepThrough });
    const flowStatus = deps.workbench.FlowStatusCacheService();
    const isWorking = async () =>
        (await flowStatus.getFlowStatus(transactionId, subscriberUrl, {}))
            .status === 'WORKING';
    const busy: LiveActionResult = {
        success: false,
        message: 'The flow is already being processed',
        transactionId,
    };
    // Refused at once while an advance holds the flow, without waiting for the lock.
    if (!settingsOnly && (await isWorking())) return busy;

    const decided = await withRunLock(
        liveRunKey(transactionId, subscriberUrl),
        async (): Promise<
            | { answer: LiveActionResult }
            | { advance: LiveAdvanceJobParams; message: string }
        > => {
            const record = await getRecord(deps, transactionId, subscriberUrl);
            if (!record)
                throw new Error(`No live run for transaction ${transactionId}`);
            const journey = journeyOf(doc, record.journeyId);
            // Again under the lock: a proceed that held it may just have claimed the flow.
            const working = await isWorking();
            // The flow is claimed (WORKING) here, before the advance is queued rather
            // than when it starts, so a second proceed is refused in between.
            const claim = async (
                advance: LiveAdvanceJobParams,
                message: string
            ) => {
                await flowStatus.setFlowStatus(
                    transactionId,
                    subscriberUrl,
                    'WORKING'
                );
                return { advance, message };
            };

            if (settingsOnly) {
                const plan = planV2(executor, record.state, journey, plays);
                // Turned off while paused: carry on as an ordinary run would.
                if (stepThrough === false && !working && plan.kind === 'run')
                    return claim(
                        { sessionId, transactionId, subscriberUrl },
                        'Step-through is off · the run carries on'
                    );
                return {
                    answer: {
                        success: true,
                        message: 'Settings saved',
                        transactionId,
                    },
                };
            }
            if (working) return { answer: busy };

            if (finish) {
                const done = finishV2(executor, record.state, journey);
                if (!done)
                    return {
                        answer: {
                            success: false,
                            message: 'The run is not at an End node',
                            transactionId,
                        },
                    };
                await saveRecord(
                    deps,
                    withLogs({ ...record, state: done }, [
                        {
                            level: 'success',
                            message: 'Run finished at an End node',
                        },
                    ])
                );
                return {
                    answer: {
                        success: true,
                        message: 'Run finished',
                        transactionId,
                    },
                };
            }

            if (triggerExtra) {
                const node = executor.getNode(triggerExtra);
                if (!node)
                    throw new Error(
                        `On-demand node ${triggerExtra} is not on the graph`
                    );
                if (plays !== 'both' && node.owner !== plays)
                    return {
                        answer: {
                            success: false,
                            message: `${triggerExtra} is the participant's to send`,
                            transactionId,
                        },
                    };
                const ask = await triggerV2(
                    executor,
                    record.state,
                    triggerExtra
                );
                if (ask.pending?.kind === 'inputs' && inputs === undefined)
                    return {
                        answer: {
                            success: true,
                            message: `${triggerExtra} needs inputs`,
                            transactionId,
                            inputs: {
                                nodeId: triggerExtra,
                                schema: ask.pending.schema,
                                extra: true,
                            },
                        },
                    };
            } else {
                const plan = planV2(executor, record.state, journey, plays);
                const answered =
                    (plan.kind === 'inputs' && inputs !== undefined) ||
                    (plan.kind === 'form' && formData !== undefined);
                if (!answered) {
                    const answer = answerFor(plan, transactionId);
                    if (answer) return { answer };
                }
            }

            return claim(
                {
                    sessionId,
                    transactionId,
                    subscriberUrl,
                    ...(inputs !== undefined ? { inputs } : {}),
                    ...(formData !== undefined ? { formData } : {}),
                    ...(triggerExtra ? { triggerExtra } : {}),
                },
                'Proceeding'
            );
        }
    );
    if ('answer' in decided) return decided.answer;

    // Outside the lock: the advance takes it.
    let jobId: string;
    try {
        jobId = await enqueueAdvance(deps, decided.advance);
    } catch (error) {
        // No job will run to release the flow.
        await flowStatus.setFlowStatus(
            transactionId,
            subscriberUrl,
            'AVAILABLE'
        );
        throw error;
    }
    return {
        success: true,
        message: decided.message,
        transactionId,
        jobIds: [jobId],
    };
};

export type LiveAdvanceJobParams = {
    sessionId: string;
    transactionId: string;
    subscriberUrl: string;
    inputs?: Record<string, unknown>;
    formData?: Record<string, unknown>;
    triggerExtra?: string;
    /**
     * With step-through on, how many payloads the job may send: 1 for a tester's
     * click (start, Run step, inputs), 0 when the participant's payload moved the run.
     * Absent means 1. Without step-through the job runs on to the next wait.
     */
    sends?: number;
};

/** Whether a step's result is a payload to send to the participant. */
const isOutgoing = (run: StepRunV2 | undefined) =>
    !!run?.ok &&
    !run.skipped &&
    run.kind !== 'decision' &&
    run.kind !== 'form' &&
    run.event?.direction === 'out' &&
    !!run.event.payload;

/**
 * The advance job: runs the mock's steps until the run waits (for the
 * participant, the tester, a form) or ends, sending each generated payload
 * through the api-service in order. Holds the flow WORKING meanwhile, as v1's
 * dispatch does, so a second proceed is refused rather than interleaved.
 *
 * Send after save: the steps run and the record is saved under the run lock; the
 * payloads are queued only after that, outside the lock (and still WORKING). A
 * payload never goes out for a run that was not stored, and the participant's
 * answer to it cannot find the run without the step that sent it.
 */
export const advanceLiveFlow = async (
    deps: LiveDeps,
    data: LiveAdvanceJobParams
): Promise<{ sent: number; plan: ReturnType<typeof summarisePlan> | null }> => {
    const flowStatus = deps.workbench.FlowStatusCacheService();
    await flowStatus.setFlowStatus(
        data.transactionId,
        data.subscriberUrl,
        'WORKING'
    );
    try {
        const { outgoing, plan, npType } = await withRunLock(
            liveRunKey(data.transactionId, data.subscriberUrl),
            () => advanceRun(deps, data)
        );
        for (const params of outgoing)
            await deps.queue.enqueue(STUDIO_LIVE_SEND_JOB, params);
        logger.info('Studio live advance done', {
            transactionId: data.transactionId,
            sessionId: data.sessionId,
            npType,
            sent: outgoing.length,
        });
        return { sent: outgoing.length, plan };
    } finally {
        await flowStatus.setFlowStatus(
            data.transactionId,
            data.subscriberUrl,
            'AVAILABLE'
        );
    }
};

/** The advance's steps, under the run lock: saves the run, returns the payloads to send. */
const advanceRun = async (
    deps: LiveDeps,
    data: LiveAdvanceJobParams
): Promise<{
    outgoing: LiveSendJobParams[];
    plan: ReturnType<typeof summarisePlan> | null;
    npType: SessionCache['npType'];
}> => {
    const { doc, executor, session, plays } = await load(deps, data.sessionId);
    let record = await getRecord(deps, data.transactionId, data.subscriberUrl);
    if (!record)
        throw new Error(`No live run for transaction ${data.transactionId}`);
    const journey = journeyOf(doc, record.journeyId);
    const outgoing: LiveSendJobParams[] = [];
    const send = (run: StepRunV2) => {
        outgoing.push({
            action: run.event!.api,
            domain: executor.options.domain,
            version: executor.options.version,
            payload: run.event!.payload,
            subscriberUrl: data.subscriberUrl,
            queryParams: {
                subscriber_url: data.subscriberUrl,
                flow_id: record!.journeyId,
                session_id: data.sessionId,
            },
            live: {
                transactionId: data.transactionId,
                subscriberUrl: data.subscriberUrl,
                label: `${run.nodeId} (${run.event!.api})`,
            },
        });
    };

    if (data.triggerExtra) {
        const out = await triggerV2(
            executor,
            record.state,
            data.triggerExtra,
            data.inputs
        );
        record = withLogs({ ...record, state: out.state }, out.logs);
        if (isOutgoing(out.run)) send(out.run!);
        await saveRecord(deps, record);
        return { outgoing, plan: null, npType: session.npType };
    }

    const { stepThrough } = await getLiveSettings(deps, data.sessionId);
    let sends = data.sends ?? 1;
    let plan: GraphPlanV2 | null = null;
    for (let i = 0; i < ADVANCE_LIMIT; i += 1) {
        if (stepThrough) {
            // Pause before each payload the mock would send, once this job's are spent.
            const ahead = planV2(executor, record.state, journey, plays);
            const sending =
                (ahead.kind === 'run' && sendsPayload(ahead.node)) ||
                (ahead.kind === 'inputs' &&
                    i === 0 &&
                    data.inputs !== undefined);
            if (sending) {
                if (sends <= 0) {
                    plan = ahead;
                    record = withLogs(record, [
                        {
                            level: 'info',
                            message: `Paused before ${ahead.node.id} (${ahead.node.api}) · step-through is on: Run step sends it`,
                        },
                    ]);
                    break;
                }
                sends -= 1;
            }
        }
        const step = await stepV2(executor, record.state, journey, {
            plays,
            ...(i === 0 && data.inputs !== undefined
                ? { inputs: data.inputs }
                : {}),
            ...(i === 0 && data.formData !== undefined
                ? { formData: data.formData }
                : {}),
        });
        record = withLogs({ ...record, state: step.state }, step.logs);
        plan = step.plan;
        if (step.outcome === 'ran' && isOutgoing(step.run)) send(step.run!);
        if (step.outcome !== 'ran') break;
    }
    await saveRecord(deps, record);
    return {
        outgoing,
        plan: plan ? summarisePlan(plan) : null,
        npType: session.npType,
    };
};

export type LiveReceiveResult =
    | { kind: 'not-live' }
    | { kind: 'accepted'; nodeId: string; jobId: string }
    | { kind: 'invalid'; nodeId: string; reason: string }
    | { kind: 'rejected'; reason: string };

/** Which live run (if any) a payload from the participant belongs to. */
export const findLiveRun = async (
    deps: LiveDeps,
    transactionId: string,
    subscriberUrl: string
): Promise<{
    sessionId: string;
    journeyId: string;
    existing: boolean;
} | null> => {
    const record = await getRecord(deps, transactionId, subscriberUrl);
    if (record)
        return {
            sessionId: record.sessionId,
            journeyId: record.journeyId,
            existing: true,
        };
    // The participant started the flow: the api-service made the transaction
    // record from our expectation, with the journey as its flow id.
    try {
        const txn = await deps.workbench
            .TransactionalCacheService()
            .getTransactionData(transactionId, subscriberUrl);
        if (!txn.sessionId) return null;
        const session = await getSession(deps, txn.sessionId);
        if (!(await isLiveSession(deps, txn.sessionId, session))) return null;
        return {
            sessionId: txn.sessionId,
            journeyId: txn.flowId,
            existing: false,
        };
    } catch {
        return null;
    }
};

const validationFailure = (run: StepRunV2) => {
    const result = run.validate?.result as
        | { valid?: boolean; code?: unknown; description?: unknown }
        | undefined;
    if (!run.validate) return null;
    if (!run.validate.success)
        return {
            code: 'VALIDATION_ERROR',
            description: run.validate.error?.message ?? 'validate failed',
        };
    if (result?.valid === false)
        return {
            code: String(result.code ?? 'VALIDATION_ERROR'),
            description: String(result.description ?? 'Validation failed'),
        };
    return null;
};

/**
 * `POST /manual/:action` for a graph-v2 session: recognise the participant's
 * payload among the steps the journey permits, validate it, save its data and
 * move the run on. An invalid payload is answered with an error callback (as
 * v1 does) and not recorded; an unrecognised one is rejected.
 */
export const receiveLivePayload = async (
    deps: LiveDeps,
    payload: { context: Record<string, unknown> },
    subscriberUrl: string
): Promise<LiveReceiveResult> => {
    const transactionId = String(payload.context.transaction_id ?? '');
    const found = await findLiveRun(deps, transactionId, subscriberUrl);
    if (!found) return { kind: 'not-live' };
    const { doc, executor, plays } = await load(deps, found.sessionId);
    const journey = journeyOf(doc, found.journeyId);

    const taken = await withRunLock(
        liveRunKey(transactionId, subscriberUrl),
        async (): Promise<
            | { kind: 'rejected'; reason: string }
            | {
                  kind: 'invalid';
                  nodeId: string;
                  reason: string;
                  errorCallback: LiveSendJobParams;
              }
            | { kind: 'accepted'; nodeId: string }
        > => {
            // Read under the lock: an advance or another payload may have written the
            // run since findLiveRun looked, or started it (a participant-opened journey).
            const stored = await getRecord(deps, transactionId, subscriberUrl);
            let record: LiveRunRecord = stored ?? {
                sessionId: found.sessionId,
                journeyId: found.journeyId,
                transactionId,
                subscriberUrl,
                state: createGraphRunV2(executor, { transactionId, journey }),
                rejected: [],
                logs: [],
                updatedAt: new Date().toISOString(),
            };
            if (!stored) {
                // The participant opens the journey: settle the new run past the
                // skips and decisions before its first request, as start did when it
                // armed the expectation, so that request is the step the run waits for.
                const settled = await settleV2(
                    executor,
                    record.state,
                    journey,
                    { plays }
                );
                record = withLogs(
                    { ...record, state: settled.state },
                    settled.steps.flatMap(step => step.logs)
                );
                await markFlowOnSession(
                    deps,
                    found.sessionId,
                    found.journeyId,
                    transactionId
                );
            }

            const reject = async (reason: string) => {
                record = withLogs(
                    {
                        ...record,
                        rejected: [
                            ...record.rejected,
                            {
                                ts: new Date().toISOString(),
                                action: payload.context.action as
                                    | string
                                    | undefined,
                                messageId: payload.context.message_id as
                                    | string
                                    | undefined,
                                reason,
                                payload,
                            },
                        ].slice(-LOG_LIMIT),
                    },
                    [{ level: 'error', message: reason }]
                );
                await saveRecord(deps, record);
                return { kind: 'rejected' as const, reason };
            };

            const got = await receiveV2(
                executor,
                record.state,
                journey,
                payload,
                { plays }
            );
            if (!got.run)
                return reject(got.error ?? 'The payload was not taken');

            const failure = validationFailure(got.run);
            if (failure) {
                const reason = `${got.run.nodeId}: ${failure.description}`;
                await reject(reason);
                const node = executor.getNode(got.run.nodeId)!;
                const api = node.api;
                const action = api.startsWith('on_')
                    ? api.slice(3)
                    : `on_${api}`;
                return {
                    kind: 'invalid',
                    nodeId: got.run.nodeId,
                    reason,
                    errorCallback: {
                        action,
                        domain: executor.options.domain,
                        version: executor.options.version,
                        live: {
                            transactionId,
                            subscriberUrl,
                            label: `error callback ${action} for ${got.run.nodeId}`,
                        },
                        payload: {
                            context: {
                                ...payload.context,
                                action,
                                timestamp: new Date().toISOString(),
                            },
                            error: {
                                code: failure.code,
                                message: failure.description,
                            },
                        },
                        subscriberUrl,
                        queryParams: {
                            flow_id: found.journeyId,
                            session_id: found.sessionId,
                            subscriber_url: subscriberUrl,
                        },
                    },
                };
            }

            const recognitions = { ...got.state.recognitions };
            const index = got.state.runs.length - 1;
            if (recognitions[index])
                recognitions[index] = slimRecognition(recognitions[index]);
            record = withLogs(
                { ...record, state: { ...got.state, recognitions } },
                got.logs
            );
            await saveRecord(deps, record);
            return { kind: 'accepted', nodeId: got.run.nodeId };
        }
    );

    // Queued outside the lock (the advance takes it), once the run is stored.
    switch (taken.kind) {
        case 'rejected':
            return taken;
        case 'invalid':
            // v1's answer: an error callback on the mirrored action.
            await deps.queue.enqueue(STUDIO_LIVE_SEND_JOB, taken.errorCallback);
            return {
                kind: 'invalid',
                nodeId: taken.nodeId,
                reason: taken.reason,
            };
        case 'accepted': {
            // With step-through on, the mock answers only when the tester clicks Run step.
            const jobId = await enqueueAdvance(deps, {
                sessionId: found.sessionId,
                transactionId,
                subscriberUrl,
                sends: 0,
            });
            return { kind: 'accepted', nodeId: taken.nodeId, jobId };
        }
    }
};

/** One payload's sync exchange, from the api-service's transaction record. */
export interface LiveExchange {
    payloadId: string;
    ack: string;
    response: unknown;
    timestamp: string;
}

/** `GET /flows/current-status` for a graph-v2 session. */
export const getLiveFlowStatus = async (
    deps: LiveDeps,
    sessionId: string,
    transactionId: string
) => {
    const { doc, executor, session, plays } = await load(deps, sessionId);
    const subscriberUrl = session.subscriberUrl;
    const record = await getRecord(deps, transactionId, subscriberUrl);
    if (!record)
        throw new Error(`No live run for transaction ${transactionId}`);
    const journey = journeyOf(doc, record.journeyId);
    const next = executor.next(record.state.session, journey);
    const working = await deps.workbench
        .FlowStatusCacheService()
        .getFlowStatus(transactionId, subscriberUrl, {});
    // The sync responses to each payload, as the api-service recorded them: the
    // participant's to what the mock sent, the mock's to what the participant sent.
    const acks: Record<string, unknown> = {};
    const exchanges: Record<string, LiveExchange> = {};
    try {
        const txn = await deps.workbench
            .TransactionalCacheService()
            .getTransactionData(transactionId, subscriberUrl);
        for (const entry of txn.apiList) {
            if (entry.entryType !== 'API') continue;
            const status = (
                entry.response as {
                    message?: { ack?: { status?: unknown } };
                } | null
            )?.message?.ack?.status;
            const ack = typeof status === 'string' ? status : 'UNKNOWN';
            const key = `${entry.action}::${entry.messageId}`;
            acks[key] = ack;
            exchanges[key] = {
                payloadId: entry.payloadId,
                ack,
                response: entry.response ?? null,
                timestamp: entry.timestamp,
            };
        }
    } catch {
        // No transaction record yet: nothing has gone through the api-service.
    }
    const deliveries = await getDeliveries(deps, transactionId, subscriberUrl);
    const plan = planV2(executor, record.state, journey, plays);
    const { stepThrough } = await getLiveSettings(deps, sessionId);
    const isWorking = working.status === 'WORKING';
    return {
        engine: 'graph-v2' as const,
        sessionId,
        journeyId: record.journeyId,
        transactionId,
        plays,
        working: isWorking,
        state: record.state,
        status: getRunStatusV2(executor, record.state, journey, plays),
        plan: summarisePlan(plan),
        stepThrough,
        /** Step-through holds the run before this node's payload until Run step. */
        paused:
            stepThrough &&
            !isWorking &&
            plan.kind === 'run' &&
            sendsPayload(plan.node)
                ? plan.node.id
                : null,
        next: {
            end: next.end,
            canEnd: !!next.canEnd,
            onDemand: next.onDemand
                .filter(n => plays === 'both' || n.owner === plays)
                .map(n => n.id),
        },
        sessionData: executor.getSessionData(record.state.session),
        acks,
        exchanges,
        rejected: record.rejected,
        // The run's own log with what the api-service made of each payload sent, in time order.
        logs: [...record.logs, ...deliveries].sort((a, b) =>
            a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
        ),
        deliveries,
    };
};

/**
 * Sends a payload of a live run to the api-service, as SEND_TO_API_SERVICE_JOB does,
 * and keeps what came back. "sent" in the run's log only means queued; whether the
 * api-service took it (ACK), refused it (NACK, with its error), failed (4xx/5xx — a
 * domain/version the build does not serve answers 404) or could not be reached is
 * what the tester needs to see, so each outcome is written to the delivery list.
 */
export const STUDIO_LIVE_SEND_JOB = 'STUDIO_LIVE_SEND_JOB';

export type LiveSendJobParams = ApiServiceRequestJobParams & {
    live: { transactionId: string; subscriberUrl: string; label: string };
};

export type LiveDelivery = DriverLogV2 & {
    ts: string;
    action: string;
    statusCode?: number;
};

const DELIVERY_LIMIT = 200;

const getDeliveries = async (
    deps: Pick<LiveDeps, 'cache'>,
    transactionId: string,
    subscriberUrl: string
): Promise<LiveDelivery[]> =>
    ((await deps.cache
        .get(liveDeliveryKey(transactionId, subscriberUrl), z.array(z.any()))
        .catch(() => null)) as LiveDelivery[] | null) ?? [];

const brief = (value: unknown, max = 240): string => {
    if (value === undefined || value === null || value === '') return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** One delivery outcome as a log line: what the api-service answered, in words. */
export const describeDelivery = (
    label: string,
    action: string,
    result: (ApiServiceRequestJobResult & { message?: string }) | undefined
): LiveDelivery => {
    const ts = new Date().toISOString();
    const status = result?.statusCode;
    const body = result?.responseBody as
        | {
              message?: { ack?: { status?: string } };
              error?: { code?: unknown; message?: unknown };
          }
        | undefined;
    const ack = body?.message?.ack?.status;
    const error = body?.error
        ? `${body.error.code ?? ''}${body.error.code && body.error.message ? ': ' : ''}${body.error.message ?? ''}`
        : '';
    const base = { ts, action, ...(status ? { statusCode: status } : {}) };
    if (result?.success && ack === 'ACK')
        return {
            ...base,
            level: 'success',
            message: `${label} delivered · ACK`,
        };
    if (ack === 'NACK')
        return {
            ...base,
            level: 'error',
            message: `${label} was refused by the api-service · NACK${error ? ` · ${error}` : ''}`,
        };
    if (result?.success)
        return {
            ...base,
            level: 'warn',
            message: `${label} sent · HTTP ${status ?? '?'} without an ACK · ${brief(body)}`,
        };
    if (status)
        return {
            ...base,
            level: 'error',
            message: `${label} failed · the api-service answered HTTP ${status}${
                status === 404
                    ? ' (no route: is the api-service built for this domain and version?)'
                    : ''
            }${error ? ` · ${error}` : body ? ` · ${brief(body)}` : ''}`,
        };
    return {
        ...base,
        level: 'error',
        message: `${label} failed · the api-service could not be reached (${process.env.API_SERVICE_URL ?? 'API_SERVICE_URL unset'})${result?.message ? ` · ${result.message}` : ''}`,
    };
};

export const createStudioLiveSendJobHandler = (
    deps: () => LiveDeps,
    send: (
        data: ApiServiceRequestJobParams
    ) => Promise<unknown> = createApiServiceRequestJobHandler()
) => {
    return async (data: LiveSendJobParams) => {
        const { live, ...params } = data;
        let result:
            | (ApiServiceRequestJobResult & { message?: string })
            | undefined;
        try {
            result = (await send(params)) as typeof result;
        } catch (error) {
            result = { success: false, message: (error as Error).message };
        }
        try {
            const d = deps();
            const key = liveDeliveryKey(live.transactionId, live.subscriberUrl);
            // Only this job writes the list, and jobs run one at a time: no lost updates,
            // and the run record itself (written by advances and receipts) is left alone.
            const list = await getDeliveries(
                d,
                live.transactionId,
                live.subscriberUrl
            );
            await d.cache.set(
                key,
                [
                    ...list,
                    describeDelivery(live.label, params.action, result),
                ].slice(-DELIVERY_LIMIT),
                z.array(z.any()),
                RUN_TTL_SECONDS
            );
        } catch (error) {
            logger.error('studio live: could not record a delivery', {}, error);
        }
        return result;
    };
};

export const createStudioLiveAdvanceJobHandler =
    (deps: () => LiveDeps) => async (data: LiveAdvanceJobParams) =>
        advanceLiveFlow(deps(), data);
