import { FormApiType, HistoryType } from '../../../types/cache-types';
import { ApiHistory, ReducedApiData } from '../../../types/mapped-flow-types';
import { isFdDomain } from '../../../fd/constants';

/** `domain` selects the ACK rule: FD's differs from Beckn's (see checkPerfectAck). */
export function reduceApiDataList(
    data: HistoryType[],
    domain?: string
): ApiHistory[] {
    const map = new Map<string, ApiHistory>();

    for (const vagueItem of data) {
        if (vagueItem.entryType === 'FORM') {
            const item = vagueItem as FormApiType;
            const key = `${item.formType}|${item.formId}|${item.submissionId}`;
            if (!map.has(key)) {
                map.set(key, {
                    entryType: 'FORM',
                    formType: item.formType,
                    formId: item.formId,
                    submissionId: item.submissionId,
                    timestamp: item.timestamp,
                    subStatus: item.error ? 'ERROR' : 'SUCCESS',
                    error: item.error,
                });
            }
        } else {
            const item = vagueItem;
            const key = `${item.action}|${item.messageId}`;
            if (!map.has(key)) {
                map.set(key, {
                    entryType: 'API',
                    action: item.action,
                    messageId: item.messageId,
                    timestamp: item.timestamp,
                    subStatus: checkPerfectAck(
                        item.response,
                        domain,
                        item.messageId
                    ),
                    payloads: [
                        {
                            payloadId: item.payloadId,
                            response: item.response,
                        },
                    ],
                });
            } else {
                const existingItem = map.get(key)! as ReducedApiData;
                existingItem.payloads.push({
                    payloadId: item.payloadId,
                    response: item.response,
                });
            }
        }
    }
    return Array.from(map.values());
}

export function checkPerfectAck(
    response: unknown,
    domain?: string,
    messageId?: string
): 'SUCCESS' | 'ERROR' {
    if (isFdDomain(domain)) {
        return checkFdPerfectResponse(response, messageId);
    }
    if (response && typeof response === 'object' && 'message' in response) {
        const typedResponse = response as {
            message?: { ack?: { status?: string } };
        };
        if (typedResponse.message?.ack?.status === 'ACK') {
            return 'SUCCESS';
        }
    }
    return 'ERROR';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * FD (ONDC:FIS14:FD). The recorded `response` is the body the receiver answered with:
 * - an ACK to an async request (fd-gate sends it with HTTP 202) is perfect only if it echoes
 *   the request's `context` (same `message_id`). The HTTP status isn't in the history, so 202
 *   and 200 are judged alike;
 * - a SYNC answer is a business body `{context, fdEnvelope, message}` with no `error`: perfect;
 * - a NACK, or any body with an `error`, is not.
 */
function checkFdPerfectResponse(
    response: unknown,
    messageId?: string
): 'SUCCESS' | 'ERROR' {
    if (!isRecord(response) || response.error !== undefined) return 'ERROR';
    const context = response.context;
    if (!isRecord(context)) return 'ERROR';
    const message = response.message;
    const ack = isRecord(message) && isRecord(message.ack) ? message.ack : null;
    if (ack) {
        if (ack.status !== 'ACK') return 'ERROR';
        if (messageId && context.message_id !== messageId) return 'ERROR';
        return 'SUCCESS';
    }
    return isRecord(message) ? 'SUCCESS' : 'ERROR';
}
