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
    openFdTransaction,
} from './engine';

/**
 * Judges an async message with the engine, keeps the state (findings included) and keeps the
 * message so the callback answering it can be drafted.
 */
export async function observeIncomingFd(
    ctx: FlowContext,
    inbound: FdInbound,
    workbenchCache: WorkbenchCacheServiceType
): Promise<FdObservation> {
    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(ctx)
    );
    const observation = await txn.observe(inbound);
    await txn.save();
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

    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(ctx)
    );
    const observation = await txn.observe(inbound);
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

    const mockRunner = step
        ? await mockRunnerCache.getRunnerInstance(
              ctx.domain,
              ctx.version,
              ctx.flowId,
              ctx.apiSessionCache.usecaseId,
              ctx.transactionData.sessionId
          )
        : undefined;
    const runnerConfig = mockRunner?.getConfig();

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
        scenario:
            step && runnerConfig
                ? fdScenarioOf(runnerConfig, step.actionId)
                : undefined,
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
