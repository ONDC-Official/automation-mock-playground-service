import { SessionCache, TransactionCache } from './cache-types';
import { InternalServerError } from '../errors/custom-errors';
import { ApiRequest } from '../routes/manualRoutes';
import { Flow } from './flow-types';

export interface FlowContext {
    flow: Flow;
    flowId: string;
    transactionId: string;
    subscriberUrl: string;
    apiSessionCache: SessionCache;
    transactionData: TransactionCache;
    domain: string;
    version: string;
    inputs?: unknown;
}

export function attachFlowContext(req: ApiRequest, context: FlowContext) {
    req.flowContext = context;
}

export function assertFlowContext(
    req: ApiRequest
): asserts req is ApiRequest & { flowContext: FlowContext } {
    if (!req.flowContext) {
        throw new InternalServerError('[DEFECT] Flow context not initialized');
    }
}
