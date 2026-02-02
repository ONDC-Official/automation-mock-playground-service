import { Router, Request } from 'express';
import { FlowContext } from '../types/process-flow-types';
import ServiceContainer from '../container/container';
import { flowControllers } from '../controllers/flow-controller';

const manualRouter = Router();

export interface ApiRequest extends Request {
    flowContext?: FlowContext;
}

const container = ServiceContainer.getInstance();

const flowControllersInstance = flowControllers(
    container.getQueueService(),
    container.getWorkbenchCacheService()
);

manualRouter.post('/:action', flowControllersInstance.actUponFlow);

export default manualRouter;
