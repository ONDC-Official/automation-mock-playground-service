import { createRedisCacheService } from '../../cache/redis-cache';
import { createInMemoryQueue } from '../../queue/InMemoryQueue';
import logger from '@ondc/automation-logger';
import ServiceContainer from '../container';
import Redis from 'ioredis';
import MockRunner from '@ondc/automation-mock-runner';

export function InitMainContainer() {
    logger.info('Initializing main container...');
    const container = ServiceContainer.getInstance();
    container.reset();

    // Redis DB 0 - workbench cache
    const redis0Client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        username: process.env.REDIS_USERNAME || undefined,
        db: parseInt(process.env.REDIS_DB_0 || '0'),
        retryStrategy: times => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
    });
    logger.info('Redis client for DB 0 initialized');
    // Redis DB 1 - config cache
    const redis1Client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        username: process.env.REDIS_USERNAME || undefined,
        db: parseInt(process.env.REDIS_DB_1 || '1'),
        retryStrategy: times => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
    });
    logger.info('Redis client for DB 1 initialized');

    const redis0Service = createRedisCacheService(redis0Client);
    const redis1Service = createRedisCacheService(redis1Client);

    container.setCacheService0(redis0Service);
    container.setCacheService1(redis1Service);

    const queue = createInMemoryQueue();
    container.setQueueService(queue);

    const fnvuUrl = process.env.FINVU_AA_SERVICE_URL;
    if (fnvuUrl) {
        MockRunner.initSharedRunner({
            allowedFetchBaseUrls: [fnvuUrl],
        });
    }
    logger.info('Main container initialized successfully');
}
