import { FormApiType, HistoryType } from '../../../types/cache-types';
import {
    ApiHistory,
    ReducedApiData,
} from '../../../types/mapped-flow-types';

export function reduceApiDataList(data: HistoryType[]): ApiHistory[] {
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
                    subStatus: checkPerfectAck(item.response),
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

export function checkPerfectAck(response: unknown): 'SUCCESS' | 'ERROR' {
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
