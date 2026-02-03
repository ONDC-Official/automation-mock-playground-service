import { Router } from 'express';
import ServiceContainer from '../container/container';
import { backdoorControllers } from '../controllers/backdoor-controller';
import { BackdoorService } from '../service/backdoor-service';

const backdoorRouter = Router();

const container = ServiceContainer.getInstance();
const cacheService = container.getMockRunnerConfigCache();
const backdoorService = new BackdoorService(cacheService);
const backdoorControllersInstance = backdoorControllers(backdoorService);

/**
 * Clear cached flow configurations from Redis
 *
 * Query Parameters:
 * - domain (required): Domain to clear
 * - version (optional): Version to clear
 * - flowId (optional): Specific flow ID to clear
 *
 * Examples:
 * - DELETE /backdoor/clear-flows?domain=retail - Clears all retail flows
 * - DELETE /backdoor/clear-flows?domain=retail&version=1.0.0 - Clears all retail v1.0.0 flows
 * - DELETE /backdoor/clear-flows?domain=retail&version=1.0.0&flowId=search-flow - Clears specific flow
 */
backdoorRouter.delete(
    '/clear-flows',
    backdoorControllersInstance.clearFlowsController
);

export default backdoorRouter;
