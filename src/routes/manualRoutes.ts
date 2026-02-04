import { Router, Request } from 'express';
import { FlowContext } from '../types/process-flow-types';
import ServiceContainer from '../container/container';
import { flowControllers } from '../controllers/flow-controller';
import { incomingRequestControllers } from '../controllers/incoming-request-controller';

const manualRouter = Router();

export interface ApiRequest extends Request {
    flowContext?: FlowContext;
}

const container = ServiceContainer.getInstance();

const flowControllersInstance = flowControllers(
    container.getQueueService(),
    container.getWorkbenchCacheService()
);

const incomingControllers = incomingRequestControllers(
    container.getWorkbenchCacheService(),
    container.getMockRunnerConfigCache(),
    container.getQueueService()
);

manualRouter.post(
    '/:action',
    flowControllersInstance.receivePayloadFromApiService,
    incomingControllers.validateAndSaveIncomingRequest,
    flowControllersInstance.actUponFlow
);

export default manualRouter;
