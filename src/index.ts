// Bootstrap container as a side-effect. MUST be the first import so it runs
// before server.ts loads (which transitively imports route files that read
// from the container at module load time).
import './container/implementations/main';

import createServer from './server';
import config from './config/server-config';
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
