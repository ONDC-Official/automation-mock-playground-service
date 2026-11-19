import { Router } from 'express';
import ServiceContainer from '../container/container';
import { fdControllers } from '../controllers/fd-controller';

const fdRouter = Router();

const container = ServiceContainer.getInstance();
const fdControllersInstance = fdControllers(
    container.getWorkbenchCacheService(),
    container.getMockRunnerConfigCache(),
    container.getQueueService()
);

/**
 * FD (ONDC:FIS14:FD) only. fd-gate calls this when it served a stored response to a repeated
 * async request; the playground re-sends the callback it sent for the original.
 *
 * Body: { domain, version, action, message_id, transaction_id, subscriber_url }
 */
fdRouter.post('/replay', fdControllersInstance.fdReplay);

export default fdRouter;
