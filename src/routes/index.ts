import { Router } from 'express';
import manualRouter from './manualRoutes';
import flowRouter from './flowRoutes';
import backdoorRouter from './backdoorRouter';
import formRouter from './formRoutes';

const router = Router();

router.use('/manual', manualRouter);
router.use('/flows', flowRouter);
router.use('/backdoor', backdoorRouter);
router.use('/forms', formRouter);
export default router;
