import { Router } from 'express';
import manualRouter from './manualRoutes';
import flowRouter from './flowRoutes';
import backdoorRouter from './backdoorRouter';
import formRouter from './formRoutes';
import studioLiveRouter from './studio-live-router';

const router = Router();

// Graph-v2 (Protocol Studio) sessions first; it hands every other session on to v1.
router.use(studioLiveRouter);

router.use('/manual', manualRouter);
router.use('/flows', flowRouter);
router.use('/backdoor', backdoorRouter);
router.use('/forms', formRouter);
export default router;
