import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { healthMonitor } from './utils/health-monitor';
import logger from './observability/log';
import { sendError, sendSuccess } from './utils/res-utils';
import { register } from './observability/metrics';
import {
    seedCorrelation,
    seedBecknContext,
    httpMetricsMiddleware,
} from './observability/trace-middleware';
// import {
//     collectMemorySnapshot,
//     takeHeapSnapshot,
// } from './utils/memory-profiler';

import { globalErrorHandler } from './middlewares/error-handler';
import router from './routes';
import { requestLogger, responseLogger } from './middlewares/http-logger';

const createServer = (): Application => {
    logger.info('Creating server...');
    const app = express();

    app.use(logger.getCorrelationIdMiddleware());
    app.use(seedCorrelation);
    app.use(httpMetricsMiddleware);
    app.use(requestLogger);
    app.use(responseLogger);
    app.use(cors());

    // Prometheus metrics endpoint
    app.get('/metrics', async (_req: Request, res: Response) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });

    // // Detailed memory snapshot endpoint
    // app.get('/memory', (_req: Request, res: Response) => {
    //     const snapshot = collectMemorySnapshot();
    //     return sendSuccess(res, snapshot);
    // });

    // // Heap dump endpoint — writes a .heapsnapshot file, open in Chrome DevTools → Memory tab
    // app.get('/heapdump', (_req: Request, res: Response) => {
    //     const filepath = takeHeapSnapshot('heap-dumps');
    //     return sendSuccess(res, { file: filepath });
    // });

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
    app.use(seedBecknContext);

    const base = '/mock/playground';
    app.use(`${base}`, router);

    // Error Handling
    app.use(globalErrorHandler);

    return app;
};

export default createServer;
