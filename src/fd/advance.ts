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
import { actOnFlowService } from '../service/flows/process-flow';
import { FlowContext } from '../types/process-flow-types';
import { fetchFlow } from '../utils/flow-utils';
import logger from '../utils/logger';

export interface FdAdvanceTarget {
    transactionId: string;
    subscriberUrl: string;
    /** The SYNC request's `context.message_id`: the recorder keys the entry by it. */
    messageId: string;
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
            const recorded = txn.apiList.some(
                e => e.entryType === 'API' && e.messageId === target.messageId
            );
            if (recorded) break;
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
