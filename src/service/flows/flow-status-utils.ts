import logger from '../../observability/log';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';

export interface ResetStepArgs {
    transactionId: string;
    subscriberUrl: string;
    /** Required only for extra steps (per-step status); ignored otherwise. */
    actionId?: string;
    isExtraStep?: boolean;
}

/**
 * Free a step back to AVAILABLE so it can be re-dispatched after a failure.
 * Extra steps carry a per-step status; sequence steps use the flow-level status.
 * Without this an errored/failed-to-send step stays WORKING until its TTL, and
 * re-triggering fails with "step ... is WORKING, cannot dispatch".
 *
 * Never throws — a reset failure is logged but must not mask the original error.
 */
export async function resetStepToAvailable(
    workbenchCache: WorkbenchCacheServiceType,
    args: ResetStepArgs
): Promise<void> {
    try {
        const flowStatusService = workbenchCache.FlowStatusCacheService();
        if (args.isExtraStep === true && args.actionId) {
            await flowStatusService.setExtraFlowStatus(
                args.transactionId,
                args.subscriberUrl,
                args.actionId,
                'AVAILABLE'
            );
        } else {
            await flowStatusService.setFlowStatus(
                args.transactionId,
                args.subscriberUrl,
                'AVAILABLE'
            );
        }
    } catch (e) {
        logger.error(
            'Failed to reset flow status to AVAILABLE',
            {
                event: 'error',
                component: 'flow',
                transactionId: args.transactionId,
                actionId: args.actionId,
            },
            e as Error
        );
    }
}
