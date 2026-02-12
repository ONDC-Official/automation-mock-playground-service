import { Router } from 'express';
import { newFormControllers } from '../controllers/form-controller';
import ServiceContainer from '../container/container';

const formRouter = Router();
const container = ServiceContainer.getInstance();

const formControllers = newFormControllers(
    container.getWorkbenchCacheService(),
    container.getMockRunnerConfigCache(),
    container.getQueueService()
);

formRouter.get('/:domain/:formId', formControllers.getFormController);
formRouter.post(
    '/:domain/:formId/submit',
    formControllers.submitFormController
);

export default formRouter;
