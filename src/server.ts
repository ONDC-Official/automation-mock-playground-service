import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { healthMonitor } from './utils/health-monitor';
import logger from '@ondc/automation-logger';
import { sendError, sendSuccess } from './utils/res-utils';

import { globalErrorHandler } from './middlewares/error-handler';
import router from './routes';
import { requestLogger, responseLogger } from './middlewares/http-logger';

const createServer = (): Application => {
    logger.info('Creating server...');
    const app = express();

    app.use(logger.getCorrelationIdMiddleware());
    app.use(requestLogger);
    app.use(responseLogger);
    app.use(cors());

    // Health Check - Before JSON validation middleware
    app.get('/health', async (req: Request, res: Response) => {
        try {
            const healthStatus = await healthMonitor.getHealthStatus();
            return sendSuccess(res, healthStatus);
        } catch (error) {
            return sendError(
                res,
                'HEALTH_CHECK_FAILED',
                'Health check failed',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
        }
    });

    app.use(express.json({ limit: '3mb' }));
    app.use(express.urlencoded({ extended: true }));

    const base = '/mock/playground';
    app.use(`${base}`, router);

    // Error Handling
    app.use(globalErrorHandler);

    return app;
};

export default createServer;
