/**
 * The workbench (as investor app) called an issuer's SYNC action. The HTTP response that came
 * back through the API service IS the issuer's answer: the engine observes it, and the body is
 * saved as the step's result in session data under `fd_responses.<actionId>`.
 *
 * The API service records the exchange (one apiList entry: the request's action and message_id,
 * the answer as `response`) and frees FLOW_STATUS; once that entry is there, the flow is moved
 * on (see advance.ts).
 */
import { IQueueService } from '../queue/IQueueService';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import logger from '../utils/logger';
import { scheduleFdAdvance } from './advance';
import { FD_RESPONSES_SESSION_KEY } from './constants';
import { actionOf, logFdFindings } from './context';
import { openFdTransaction } from './engine';
import { FdSendMeta } from './outgoing';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

export async function handleFdSyncAnswer(
    deps: { workbenchCache: WorkbenchCacheServiceType; queue: IQueueService },
    sync: NonNullable<FdSendMeta['syncAnswer']>,
    request: { action: string; pathParams: Record<string, string> },
    response: { status?: number; body: unknown }
): Promise<void> {
    const { key } = sync;
    const meta = {
        transactionId: key.transactionId,
        action: request.action,
        requestMessageId: sync.requestMessageId,
        httpStatus: response.status,
    };
    if (!isRecord(response.body)) {
        logger.warning(
            'FD SYNC: the counterparty answer is not a JSON object; nothing to observe',
            meta
        );
    } else {
        const txn = await openFdTransaction(deps.workbenchCache, key);
        let observation;
        try {
            observation = await txn.observe({
                body: response.body,
                action: actionOf(response.body) ?? request.action,
                method: sync.method,
                pathParams: request.pathParams,
                httpStatus: response.status,
                receivedAt: new Date().toISOString(),
                requestMessageId: sync.requestMessageId,
            });
            await txn.save();
        } finally {
            await txn.release();
        }
        logFdFindings(observation.findings, meta);

        const sessionCache = deps.workbenchCache.TxnBusinessCacheService();
        const session = await sessionCache.getMockSessionData(
            key.transactionId,
            key.subscriberUrl,
            sync.sessionId
        );
        const responses = isRecord(session[FD_RESPONSES_SESSION_KEY])
            ? (session[FD_RESPONSES_SESSION_KEY] as Record<string, unknown>)
            : {};
        await sessionCache.overwriteMockSessionData(
            key.transactionId,
            key.subscriberUrl,
            {
                ...session,
                [FD_RESPONSES_SESSION_KEY]: {
                    ...responses,
                    [sync.actionId]: response.body,
                },
            }
        );
    }

    if (sync.requestMessageId) {
        void scheduleFdAdvance(deps, {
            transactionId: key.transactionId,
            subscriberUrl: key.subscriberUrl,
            messageId: sync.requestMessageId,
        });
    }
}
