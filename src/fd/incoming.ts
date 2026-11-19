/**
 * Messages an NP sends to the workbench in an FD flow (`POST /manual/:action`).
 *
 * - async (a request answered later by a callback, a callback, a webhook): `observeIncomingFd`
 *   judges it with the engine before the step's validate script runs; the regular
 *   validate/save path then continues.
 * - SYNC (fd-gate proxies the NP's request and waits): `answerFdSync` builds the answer inline.
 */
import { MockRunnerConfigCache } from '../service/cache/config-cache';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import { getFlowCompleteStatus } from '../service/flows/flow-mapper';
import { MappedStep } from '../types/mapped-flow-types';
import { FlowContext } from '../types/process-flow-types';
import logger from '../utils/logger';
import { getSaveDataConfig } from '../utils/runner-utils';
import { FD_DRAFT_SESSION_KEY, FD_STATE_TTL_SECONDS } from './constants';
import {
    fdKeyFromFlowContext,
    fdScenarioOf,
    logFdFindings,
    messageIdOf,
    stripFdScenario,
} from './context';
import {
    FdInbound,
    FdObservation,
    FdRouteInfo,
    FdScenario,
    getFdRoute,
    openFdTransaction,
} from './engine';

/**
 * The scenario of the flow step that will answer an NP's asynchronous request: the first
 * pending step of the request's callback action. The engine applies it when it decides the
 * request (a refusal the step forces must not take effect as an acceptance first). Looked up
 * by the callback step, not by the request's own step: the recorder may already have marked
 * the request's step complete.
 */
async function answeringScenario(
    ctx: FlowContext,
    route: FdRouteInfo | undefined,
    deps: {
        workbenchCache: WorkbenchCacheServiceType;
        mockRunnerCache?: MockRunnerConfigCache;
    }
): Promise<FdScenario | undefined> {
    if (!route || route.kind !== 'request' || !route.callback) return undefined;
    if (!deps.mockRunnerCache) return undefined;
    try {
        const logMeta = {
            transactionId: ctx.transactionId,
            action: route.action,
        };
        const [flowStatus, sessionData] = await Promise.all([
            deps.workbenchCache
                .FlowStatusCacheService()
                .getFlowStatus(ctx.transactionId, ctx.subscriberUrl, logMeta),
            deps.workbenchCache
                .TxnBusinessCacheService()
                .getMockSessionData(
                    ctx.transactionId,
                    ctx.subscriberUrl,
                    ctx.sessionId
                ),
        ]);
        const flowMap = getFlowCompleteStatus(
            ctx.transactionData,
            ctx.flow,
            flowStatus.status,
            sessionData,
            undefined,
            ctx.domain
        );
        const answer = flowMap.sequence.find(
            s => s.actionType === route.callback && s.status !== 'COMPLETE'
        );
        if (!answer) return undefined;
        const runner = await deps.mockRunnerCache.getRunnerInstance(
            ctx.domain,
            ctx.version,
            ctx.flowId,
            ctx.apiSessionCache.usecaseId,
            ctx.transactionData.sessionId
        );
        return fdScenarioOf(runner.getConfig(), answer.actionId);
    } catch (e) {
        logger.warning('FD: the answering step could not be looked up', {
            transactionId: ctx.transactionId,
            action: route.action,
            error: (e as Error).message,
        });
        return undefined;
    }
}

/**
 * Judges an async message with the engine, keeps the state (findings included) and keeps the
 * message so the callback answering it can be drafted.
 */
export async function observeIncomingFd(
    ctx: FlowContext,
    inbound: FdInbound,
    workbenchCache: WorkbenchCacheServiceType,
    mockRunnerCache?: MockRunnerConfigCache
): Promise<FdObservation> {
    const route = await getFdRoute(ctx.domain, ctx.version, inbound.action);
    const scenario = await answeringScenario(ctx, route, {
        workbenchCache,
        mockRunnerCache,
    });
    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(ctx)
    );
    let observation: FdObservation;
    try {
        observation = await txn.observe(
            scenario ? { ...inbound, scenario } : inbound
        );
        await txn.save();
    } finally {
        await txn.release();
    }
    logFdFindings(observation.findings, {
        transactionId: ctx.transactionId,
        action: inbound.action,
        messageId: messageIdOf(inbound.body),
        replayOf: observation.replayOf,
    });
    if (!observation.replayOf) {
        await workbenchCache
            .FdCacheService()
            .setInbound(
                ctx.transactionId,
                ctx.subscriberUrl,
                inbound.action,
                inbound,
                FD_STATE_TTL_SECONDS
            );
    }
    return observation;
}

/** True when fd-gate proxied an NP's SYNC request here and waits for the answer. */
export function isFdSyncRequest(
    routeHeader: string | undefined,
    route: FdRouteInfo | undefined
): boolean {
    return (
        !!routeHeader &&
        !!route &&
        route.mode === 'SYNC' &&
        route.kind === 'request'
    );
}

export interface FdSyncAnswer {
    httpStatus: number;
    body: unknown;
    /** False for a replayed request: the flow must not move on. */
    advance: boolean;
    /** The request's message_id: the recorder keys the exchange by it. */
    requestMessageId?: string;
    stepActionId?: string;
}

/** The flow step a SYNC request stands for: the pending step of that action, if any. */
function findSyncStep(
    steps: MappedStep[],
    action: string
): MappedStep | undefined {
    const candidates = steps.filter(
        s => s.actionType === action && s.status !== 'COMPLETE'
    );
    return candidates.find(s => s.status === 'LISTENING') ?? candidates[0];
}

/**
 * Answers an NP's SYNC request inline: observe → draft (answering it) → the step's generate
 * script on the draft → sent. No queue, no dispatch. The caller writes the answer and, unless
 * it was a replay, moves the flow on once the API service has recorded the exchange.
 */
export async function answerFdSync(
    ctx: FlowContext,
    inbound: FdInbound,
    deps: {
        workbenchCache: WorkbenchCacheServiceType;
        mockRunnerCache: MockRunnerConfigCache;
    }
): Promise<FdSyncAnswer> {
    const { workbenchCache, mockRunnerCache } = deps;
    const action = inbound.action;
    const requestMessageId = messageIdOf(inbound.body);
    const logMeta = {
        transactionId: ctx.transactionId,
        action,
        messageId: requestMessageId,
    };

    const txnCache = workbenchCache.TxnBusinessCacheService();
    const [flowStatus, sessionData] = await Promise.all([
        workbenchCache
            .FlowStatusCacheService()
            .getFlowStatus(ctx.transactionId, ctx.subscriberUrl, logMeta),
        txnCache.getMockSessionData(
            ctx.transactionId,
            ctx.subscriberUrl,
            ctx.sessionId
        ),
    ]);
    const flowMap = getFlowCompleteStatus(
        ctx.transactionData,
        ctx.flow,
        flowStatus.status,
        sessionData,
        undefined,
        ctx.domain
    );
    const step = findSyncStep(
        [...flowMap.sequence, ...(flowMap.extraSteps ?? [])],
        action
    );

    // Looked up before the request is decided, for its scenario. A runner that cannot be
    // loaded must not keep a replay from its stored answer: it is logged, and the answer is
    // then the engine's draft alone.
    let mockRunner:
        | Awaited<ReturnType<MockRunnerConfigCache['getRunnerInstance']>>
        | undefined;
    if (step) {
        try {
            mockRunner = await mockRunnerCache.getRunnerInstance(
                ctx.domain,
                ctx.version,
                ctx.flowId,
                ctx.apiSessionCache.usecaseId,
                ctx.transactionData.sessionId
            );
        } catch (e) {
            logger.error(
                'FD SYNC: the flow step runner could not be loaded; answering with the engine draft',
                { ...logMeta, actionId: step.actionId },
                e
            );
        }
    }
    const runnerConfig = mockRunner?.getConfig();
    // The step's scenario is applied when the request is decided and when it is answered.
    const scenario =
        step && runnerConfig
            ? fdScenarioOf(runnerConfig, step.actionId)
            : undefined;

    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(ctx)
    );
    try {
        return await answerLocked();
    } finally {
        await txn.release();
    }

    async function answerLocked(): Promise<FdSyncAnswer> {
        const observation = await txn.observe(
            scenario ? { ...inbound, scenario } : inbound
        );
        logFdFindings(observation.findings, {
            ...logMeta,
            replayOf: observation.replayOf,
        });

        if (observation.replayOf) {
            const original = txn.replayFor(observation.replayOf);
            if (original) {
                await txn.save();
                logger.info('FD SYNC: replayed request, answering as before', {
                    ...logMeta,
                    replayOf: observation.replayOf,
                });
                return {
                    httpStatus: 200,
                    body: original.body,
                    advance: false,
                    requestMessageId,
                };
            }
            logger.warning(
                'FD SYNC: replayed request with no stored answer; drafting one',
                { ...logMeta, replayOf: observation.replayOf }
            );
        }

        // Save the request as /manual does for any NP message, so the script sees it.
        let scriptSession = sessionData;
        if (step && runnerConfig) {
            await txnCache.saveMockSessionData(
                ctx.transactionId,
                ctx.subscriberUrl,
                inbound.body,
                { 'save-data': getSaveDataConfig(runnerConfig, step.actionId) },
                ctx.sessionId
            );
            scriptSession = await txnCache.getMockSessionData(
                ctx.transactionId,
                ctx.subscriberUrl,
                ctx.sessionId
            );
        } else {
            logger.warning(
                'FD SYNC: no pending flow step for this action; answering with the engine draft alone',
                logMeta
            );
        }

        const draft = await txn.draft({
            action,
            answering: inbound,
            scenario,
        });

        let body: unknown = draft.body;
        if (step && mockRunner) {
            const gen = await mockRunner.runGeneratePayloadWithSession(
                step.actionId,
                { ...scriptSession, [FD_DRAFT_SESSION_KEY]: draft.body }
            );
            if (gen.success === false || gen.result === undefined) {
                logger.error(
                    'FD SYNC: the step generate script failed; answering with the engine draft',
                    { ...logMeta, actionId: step.actionId },
                    gen.error
                );
            } else {
                body = gen.result;
            }
        }
        body = stripFdScenario(body);

        txn.sent({
            action,
            body,
            pathParams: draft.pathParams,
            answering: requestMessageId,
        });
        await txn.save();

        return {
            httpStatus: draft.httpStatus ?? 200,
            body,
            advance: true,
            requestMessageId,
            stepActionId: step?.actionId,
        };
    }
}
