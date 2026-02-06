import validateEnv from './env';
import { InitMainContainer } from './container/implementations/main';
import config from './config/server-config';

// Initialize environment and container FIRST, before any imports that use them
validateEnv();
InitMainContainer();

// Now safe to import server which imports routes
import createServer from './server';
import logger from '@ondc/automation-logger';

const app = createServer();

const server = app.listen(config.port, async () => {
    logger.info(
        `Server running on port ${config.port} in ${config.environment} mode`
    );
});

const shutdown = async (exitCode: number, err?: Error) => {
    if (err) {
        logger.error(`Fatal error: ${err.message}`);
        logger.error(err.stack || '');
    }

    logger.info('Shutdown signal received: closing HTTP server');

    server.close(async () => {
        logger.info('HTTP server closed!');
        process.exit(exitCode);
    });
};

// ---- Graceful shutdown signals ----
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ---- Fatal error handlers ----
process.on('uncaughtException', err => {
    shutdown(1, err);
});

process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    shutdown(1, error);
});
