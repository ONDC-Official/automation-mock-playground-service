import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { healthMonitor } from './utils/health-monitor';
import logger from './utils/logger';
import { sendError, sendSuccess } from './utils/res-utils';
import { correlationIdMiddleware } from './utils/logger/middleware/correlation-middleware';
import { httpLogger } from './middlewares/http-logger';
import { globalErrorHandler } from './middlewares/error-handler';
import { requireJsonContent } from './middlewares/http-validations';
import router from './routes';

const createServer = (): Application => {
    logger.info('Creating server...');
    const app = express();

    app.use(correlationIdMiddleware);
    app.use(httpLogger);
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

    app.use(requireJsonContent);
    app.use(express.json({ limit: '3mb' }));

    const base = '/mock/playground';
    app.use(`${base}`, router);

    // Error Handling
    app.use(globalErrorHandler);

    return app;
};

export default createServer;
