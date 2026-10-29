/**
 * `POST …/fd/replay` (M2-DESIGN §6). fd-gate served a stored response to a repeated async
 * request; the playground re-sends the callback it sent for the original, unchanged, through
 * the API service's `mock/` route with `X-Pwb-Fd-Replay: 1`.
 */
import { z } from 'zod';
import { IQueueService } from '../queue/IQueueService';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import {
    ApiServiceRequestJobParams,
    SEND_TO_API_SERVICE_JOB,
} from '../service/jobs/api-service-request';
import logger from '../utils/logger';
import { fdKeyFromSession } from './context';
import { isFdDomain } from './constants';
import { openFdTransaction } from './engine';

export const fdReplayBodySchema = z.object({
    domain: z.string().refine(isFdDomain, 'domain must be ONDC:FIS14:FD'),
    version: z.string().min(1),
    action: z.string().min(1),
    message_id: z.string().min(1),
    transaction_id: z.string().min(1),
    subscriber_url: z.string().min(1),
});

export type FdReplayBody = z.infer<typeof fdReplayBodySchema>;

export type FdReplayResult =
    | { replayed: true; action: string; jobId: string }
    | { replayed: false; reason: string };

export async function replayFdCallback(
    body: FdReplayBody,
    deps: { workbenchCache: WorkbenchCacheServiceType; queue: IQueueService }
): Promise<FdReplayResult> {
    const meta = {
        transactionId: body.transaction_id,
        subscriberUrl: body.subscriber_url,
        action: body.action,
        messageId: body.message_id,
    };
    const transaction = await deps.workbenchCache
        .TransactionalCacheService()
        .getTransactionData(body.transaction_id, body.subscriber_url);
    if (!transaction.sessionId) {
        return { replayed: false, reason: 'transaction has no session' };
    }
    const session = await deps.workbenchCache
        .NpSessionalCacheService()
        .getSessionData(transaction.sessionId);

    const txn = await openFdTransaction(
        deps.workbenchCache,
        fdKeyFromSession(
            session,
            body.transaction_id,
            body.subscriber_url,
            body.domain,
            body.version
        )
    );
    const original = txn.replayFor(body.message_id);
    if (!original) {
        logger.warning('FD replay: no message was sent for this request', meta);
        return {
            replayed: false,
            reason: `no callback was sent for message_id ${body.message_id}`,
        };
    }

    const job: ApiServiceRequestJobParams = {
        action: original.action,
        domain: body.domain,
        version: body.version,
        payload: original.body,
        subscriberUrl: body.subscriber_url,
        queryParams: {
            subscriber_url: body.subscriber_url,
            flow_id: transaction.flowId,
            session_id: transaction.sessionId,
        },
        fd: {
            pathParams: original.pathParams ?? {},
            replay: true,
        },
    };
    const jobId = await deps.queue.enqueue(SEND_TO_API_SERVICE_JOB, job);

    // Recorded as a replay in the engine state, for the report.
    txn.sent({
        action: original.action,
        body: original.body,
        pathParams: original.pathParams,
        answering: body.message_id,
        replay: true,
    });
    await txn.save();
    logger.info('FD replay: original callback re-sent', {
        ...meta,
        callback: original.action,
        jobId,
    });
    return { replayed: true, action: original.action, jobId };
}
