import { Router, Request } from 'express';
import { SessionCache, TransactionCache } from '../types/cache-types';
import { Flow } from '../types/flow-types';

const manualRouter = Router();

export interface ApiRequest extends Request {
    flow?: Flow;
    transactionData?: TransactionCache;
    transactionId?: string;
    subscriberUrl?: string;
    flowId?: string;
    apiSessionCache?: SessionCache;
    inputs?: Record<string, unknown>;
    domain: string;
    version: string;
}
manualRouter.post('/:action');

export default manualRouter;
