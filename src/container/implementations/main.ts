// Side-effect module: loads .env, validates required vars, and initializes the
// ServiceContainer. Importing this module (even with no bindings) triggers the
// full bootstrap. Must be imported BEFORE any module that reads from the
// container at top level (e.g. route files).
import 'dotenv/config';
import validateEnv from '../../env';
import { createRedisCacheService } from '../../cache/redis-cache';
import { createInMemoryQueue } from '../../queue/InMemoryQueue';
import logger from '../../observability/log';
import ServiceContainer from '../container';
import Redis from 'ioredis';
import MockRunner from '@ondc/automation-mock-runner';

validateEnv();

logger.info('Initializing main container...');
const container = ServiceContainer.getInstance();
container.reset();

const redis0Client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    username: process.env.REDIS_USERNAME || undefined,
    db: parseInt(process.env.REDIS_DB_0 || '0'),
    retryStrategy: times => Math.min(times * 50, 2000),
});
logger.info('Redis client for DB 0 initialized');

const redis1Client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    username: process.env.REDIS_USERNAME || undefined,
    db: parseInt(process.env.REDIS_DB_1 || '1'),
    retryStrategy: times => Math.min(times * 50, 2000),
});
logger.info('Redis client for DB 1 initialized');

container.setCacheService0(createRedisCacheService(redis0Client));
container.setCacheService1(createRedisCacheService(redis1Client));
container.setQueueService(createInMemoryQueue());

const fnvuUrl = process.env.FINVU_AA_SERVICE_URL;
if (fnvuUrl) {
    MockRunner.initSharedRunner({ allowedFetchBaseUrls: [fnvuUrl] });
}
logger.info('Main container initialized successfully');
