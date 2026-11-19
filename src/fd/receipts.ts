/**
 * The NP's answer to each FD message the workbench delivered asynchronously (a request, a
 * callback or a webhook): its acknowledgement, judged by the engine.
 *
 * - As issuer, each receipt of a callback or webhook is recorded against the delivered
 *   message; a NACK of a correct message, or a redelivery (scenario 12: the same bytes again)
 *   answered differently from the first, is a finding.
 * - As investor app, a refused request is judged like a refused callback, and a retried
 *   request (scenario 35) must be acknowledged as the original was.
 *
 * A refusal by the workbench's own edge (`X-Pwb-Fd-Gate-Error`) is not the NP's answer, and
 * is only logged.
 */
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import logger from '../utils/logger';
import { FD_HEADERS } from './constants';
import { fdKeyFromSession, logFdFindings, messageIdOf } from './context';
import { openFdTransaction } from './engine';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** One delivery's outcome: the HTTP answer, or a transport failure. */
export interface FdReceipt {
    status?: number;
    body?: unknown;
    headers?: Record<string, unknown>;
    error?: string;
}

export interface FdDelivered {
    action: string;
    domain: string;
    version: string;
    subscriberUrl: string;
    payload: unknown;
    pathParams: Record<string, string>;
}

function header(
    headers: Record<string, unknown> | undefined,
    name: string
): string | undefined {
    if (!headers) return undefined;
    const wanted = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === wanted)
            return Array.isArray(v) ? String(v[0]) : String(v);
    }
    return undefined;
}

/**
 * Records extra deliveries as re-sends of the message, then lets the engine judge every
 * receipt, in order, under the transaction's lock.
 */
export async function observeFdReceipts(
    workbenchCache: WorkbenchCacheServiceType,
    sent: FdDelivered,
    receipts: FdReceipt[]
): Promise<void> {
    const context = isRecord(sent.payload) ? sent.payload.context : undefined;
    const transactionId = isRecord(context)
        ? context.transaction_id
        : undefined;
    const messageId = messageIdOf(sent.payload);
    if (typeof transactionId !== 'string' || !messageId) return;
    const meta = {
        transactionId,
        action: sent.action,
        messageId,
        deliveries: receipts.length,
    };
    const transaction = await workbenchCache
        .TransactionalCacheService()
        .getTransactionData(transactionId, sent.subscriberUrl);
    if (!transaction.sessionId) {
        logger.warning('FD receipts: the transaction has no session', meta);
        return;
    }
    const session = await workbenchCache
        .NpSessionalCacheService()
        .getSessionData(transaction.sessionId);
    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromSession(
            session,
            transactionId,
            sent.subscriberUrl,
            sent.domain,
            sent.version
        )
    );
    try {
        // The first delivery was recorded when it was drafted; the rest are the same bytes.
        for (let i = 1; i < receipts.length; i++) {
            txn.sent({
                action: sent.action,
                body: sent.payload,
                pathParams: sent.pathParams,
                replay: true,
            });
        }
        for (const [i, receipt] of receipts.entries()) {
            const at = { ...meta, delivery: i + 1, httpStatus: receipt.status };
            if (receipt.status === undefined) {
                logger.warning(
                    'FD receipts: the delivery failed in transport',
                    {
                        ...at,
                        error: receipt.error,
                    }
                );
                continue;
            }
            const gateError = header(receipt.headers, FD_HEADERS.gateError);
            if (gateError) {
                logger.warning(
                    "FD receipts: refused by the workbench's own edge, not the NP; not judged",
                    { ...at, gateError }
                );
                continue;
            }
            if (!isRecord(receipt.body)) {
                logger.warning(
                    'FD receipts: the answer is not a JSON object',
                    at
                );
                continue;
            }
            const observation = await txn.observe({
                body: receipt.body,
                action: sent.action,
                method: 'POST',
                httpStatus: receipt.status,
                receivedAt: new Date().toISOString(),
            });
            logFdFindings(observation.findings, { ...at, receipt: true });
        }
        await txn.save();
    } finally {
        await txn.release();
    }
}
