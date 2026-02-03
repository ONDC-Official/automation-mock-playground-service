import { Router } from 'express';
import manualRouter from './manualRoutes';
import flowRouter from './flowRoutes';
import backdoorRouter from './backdoorRouter';

const router = Router();

router.use('/manual', manualRouter);
router.use('/flows', flowRouter);
router.use('/backdoor', backdoorRouter);
export default router;
