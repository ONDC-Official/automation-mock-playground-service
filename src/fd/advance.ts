/**
 * Moving an FD flow on after a SYNC exchange.
 *
 * A SYNC exchange (an NP's SYNC request the playground answers inline, or a workbench SYNC
 * request the NP answers inline) is recorded by the API service: network-observability sends
 * the request and the answer to the recorder, which appends ONE `apiList` entry (the request's
 * action and `message_id`, the answer as `response`) and sets `FLOW_STATUS` to AVAILABLE. That
 * entry is what makes the flow mapper show the step COMPLETE. The recorder works off the
 * response path, so the entry lands shortly after the answer was written.
 *
 * For an async message, `/manual/:action` runs `actOnFlowService` once the record exists, which
 * dispatches the workbench's next step. A SYNC answer has no such second call, so this module
 * does the same thing out of band: it waits for the recorder's entry, then runs the flow
 * dispatcher once. Without it, a workbench step that follows a SYNC step and has neither inputs
 * nor `force_proceed` would wait for a manual proceed.
 */
import { IQueueService } from '../queue/IQueueService';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import { getFlowCompleteStatus } from '../service/flows/flow-mapper';
import { actOnFlowService } from '../service/flows/process-flow';
import { FlowContext } from '../types/process-flow-types';
import { fetchFlow } from '../utils/flow-utils';
import logger from '../utils/logger';

export interface FdAdvanceTarget {
    transactionId: string;
    subscriberUrl: string;
    /** The SYNC request's `context.message_id`: the recorder keys the entry by it. */
    messageId: string;
    /**
     * Wait for at least this many history entries with `messageId` (default 1). A re-send of
     * a message already recorded waits for its own entry, not the original's.
     */
    minEntries?: number;
    /**
     * The flow step whose send this follows. If, once recorded, that step is still the next
     * one pending, the send did not complete it: the flow is not dispatched again (that would
     * re-send it in a loop).
     */
    sentActionId?: string;
}

export interface FdAdvanceOptions {
    timeoutMs?: number;
    intervalMs?: number;
    /** Wait after the entry appears, for the recorder's FLOW_STATUS write that follows it. */
    graceMs?: number;
}

const DEFAULTS: Required<FdAdvanceOptions> = {
    timeoutMs: 10_000,
    intervalMs: 150,
    graceMs: 250,
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Rebuilds a flow context from the caches, as `receivePayloadFromApiService` does. */
export async function loadFlowContext(
    workbenchCache: WorkbenchCacheServiceType,
    transactionId: string,
    subscriberUrl: string
): Promise<FlowContext> {
    const transactionData = await workbenchCache
        .TransactionalCacheService()
        .getTransactionData(transactionId, subscriberUrl);
    const sessionId = transactionData.sessionId;
    if (!sessionId) {
        throw new Error('Session ID not found in transaction data');
    }
    const sessionData = await workbenchCache
        .NpSessionalCacheService()
        .getSessionData(sessionId);
    return {
        flow: fetchFlow(sessionData, transactionData.flowId),
        flowId: transactionData.flowId,
        transactionId,
        sessionId,
        subscriberUrl,
        apiSessionCache: sessionData,
        transactionData,
        domain: sessionData.domain,
        version: sessionData.version,
    };
}

/** Waits for the recorder's entry of a SYNC exchange, then dispatches the next step. */
export async function advanceAfterSyncExchange(
    deps: { workbenchCache: WorkbenchCacheServiceType; queue: IQueueService },
    target: FdAdvanceTarget,
    options: FdAdvanceOptions = {}
): Promise<boolean> {
    const opts = { ...DEFAULTS, ...options };
    const meta = { ...target };
    const deadline = Date.now() + opts.timeoutMs;
    const txnCache = deps.workbenchCache.TransactionalCacheService();
    for (;;) {
        try {
            const txn = await txnCache.getTransactionData(
                target.transactionId,
                target.subscriberUrl
            );
            const recorded = txn.apiList.filter(
                e => e.entryType === 'API' && e.messageId === target.messageId
            ).length;
            if (recorded >= (target.minEntries ?? 1)) break;
        } catch (e) {
            logger.debug('FD advance: transaction not readable yet', {
                ...meta,
                error: (e as Error).message,
            });
        }
        if (Date.now() >= deadline) {
            logger.warning(
                'FD advance: the SYNC exchange was not recorded in time; the flow was not moved on',
                { ...meta, timeoutMs: opts.timeoutMs }
            );
            return false;
        }
        await sleep(opts.intervalMs);
    }
    if (opts.graceMs > 0) await sleep(opts.graceMs);
    const flowContext = await loadFlowContext(
        deps.workbenchCache,
        target.transactionId,
        target.subscriberUrl
    );
    if (
        target.sentActionId &&
        (await stillPending(deps, flowContext, target))
    ) {
        logger.error(
            'FD advance: the step just sent is still pending once recorded; not dispatching it again',
            { ...meta }
        );
        return false;
    }
    const result = await actOnFlowService(
        flowContext,
        deps.workbenchCache,
        deps.queue
    );
    logger.info('FD advance: flow dispatched after the SYNC exchange', {
        ...meta,
        result,
    });
    return true;
}

/** True when the step the send was for is still the next step of the sequence. */
async function stillPending(
    deps: { workbenchCache: WorkbenchCacheServiceType },
    flowContext: FlowContext,
    target: FdAdvanceTarget
): Promise<boolean> {
    const [flowStatus, sessionData] = await Promise.all([
        deps.workbenchCache
            .FlowStatusCacheService()
            .getFlowStatus(target.transactionId, target.subscriberUrl, {}),
        deps.workbenchCache
            .TxnBusinessCacheService()
            .getMockSessionData(
                target.transactionId,
                target.subscriberUrl,
                flowContext.sessionId
            ),
    ]);
    const map = getFlowCompleteStatus(
        flowContext.transactionData,
        flowContext.flow,
        flowStatus.status,
        sessionData,
        undefined,
        flowContext.domain
    );
    const next = map.sequence.find(s => s.status !== 'COMPLETE');
    return next?.actionId === target.sentActionId;
}

/** Fire-and-forget form: never throws, logs failures. */
export function scheduleFdAdvance(
    deps: { workbenchCache: WorkbenchCacheServiceType; queue: IQueueService },
    target: FdAdvanceTarget,
    options?: FdAdvanceOptions
): Promise<boolean> {
    return advanceAfterSyncExchange(deps, target, options).catch(e => {
        logger.error('FD advance failed', { ...target }, e);
        return false;
    });
}
