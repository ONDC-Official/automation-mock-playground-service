import { Router } from 'express';
import validateRequiredParams from '../middlewares/validateParams';
import { flowControllers } from '../controllers/flow-controller';
import ServiceContainer from '../container/container';

const flowRouter = Router();

const container = ServiceContainer.getInstance();

const flowControllersInstance = flowControllers(
    container.getQueueService(),
    container.getWorkbenchCacheService()
);

flowRouter.post(
    '/new',
    flowControllersInstance.startNewFlowController,
    flowControllersInstance.actUponFlow
);

flowRouter.post(
    '/proceed',
    flowControllersInstance.proceedWithFlowController,
    flowControllersInstance.actUponFlow
);

flowRouter.get(
    '/current-status',
    validateRequiredParams(['transaction_id', 'session_id']),
    flowControllersInstance.getFlowStatusController
);

export default flowRouter;
