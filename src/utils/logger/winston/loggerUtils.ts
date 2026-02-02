import { MockRequest } from '../../../types/request-types';

export function getLoggerData(request: MockRequest) {
    return {
        correlationId: request.correlationId,
        flowId: request?.flowId,
        transactionId:
            request.transactionId ??
            (request?.body?.context as any)?.transaction_id ??
            request.query.transaction_id,
        subscriberUrl: request.subscriberUrl,
        query: request.query,
        params: request.params,
        queryData: request.queryData,
        sessionId:
            request.transactionData?.sessionId ?? request.query.session_id,
    };
}
