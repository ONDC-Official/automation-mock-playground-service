import { ICacheService } from './cache-interface';
import Redis from 'ioredis';
import { z } from 'zod';
import logger from '../observability/log';
import {
    cacheOperationsTotal,
    cacheOperationDuration,
} from '../observability/metrics';

export function createRedisCacheService(redisClient: Redis): ICacheService {
    const db = String(redisClient.options?.db ?? 'unknown');

    return {
        async get<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
            const end = cacheOperationDuration.startTimer({
                cache_op: 'get',
                db,
            });
            let result = 'hit';
            try {
                const raw = await redisClient.get(key);

                if (raw === null) {
                    result = 'miss';
                    return null;
                }

                const parsed = JSON.parse(raw);
                return schema.parse(parsed);
            } catch (error) {
                result = 'error';
                if (error instanceof z.ZodError) {
                    logger.error(
                        `Cache data validation failed for key: ${key}`,
                        {},
                        error
                    );
                    return null;
                }
                throw error;
            } finally {
                end();
                cacheOperationsTotal.inc({ cache_op: 'get', result, db });
            }
        },

        async set<T>(
            key: string,
            value: unknown,
            schema: z.ZodType<T>,
            ttlSeconds?: number
        ): Promise<void> {
            const end = cacheOperationDuration.startTimer({
                cache_op: 'set',
                db,
            });
            let result = 'ok';
            try {
                // Validate before caching
                const validated = schema.parse(value);
                const serialized = JSON.stringify(validated);

                if (ttlSeconds) {
                    await redisClient.setex(key, ttlSeconds, serialized);
                } else {
                    await redisClient.set(key, serialized);
                }
            } catch (error) {
                result = 'error';
                throw error;
            } finally {
                end();
                cacheOperationsTotal.inc({ cache_op: 'set', result, db });
            }
        },

        async delete(key: string): Promise<void> {
            const end = cacheOperationDuration.startTimer({
                cache_op: 'delete',
                db,
            });
            let result = 'ok';
            try {
                await redisClient.del(key);
            } catch (error) {
                result = 'error';
                throw error;
            } finally {
                end();
                cacheOperationsTotal.inc({ cache_op: 'delete', result, db });
            }
        },

        async exists(key: string): Promise<boolean> {
            const end = cacheOperationDuration.startTimer({
                cache_op: 'exists',
                db,
            });
            let result = 'miss';
            try {
                const found = await redisClient.exists(key);
                result = found === 1 ? 'hit' : 'miss';
                return found === 1;
            } catch (error) {
                result = 'error';
                throw error;
            } finally {
                end();
                cacheOperationsTotal.inc({ cache_op: 'exists', result, db });
            }
        },

        async deletePattern(pattern: string): Promise<number> {
            const end = cacheOperationDuration.startTimer({
                cache_op: 'deletePattern',
                db,
            });
            let result = 'ok';
            try {
                const keys = await redisClient.keys(pattern);
                if (keys.length === 0) {
                    return 0;
                }
                return await redisClient.del(...keys);
            } catch (error) {
                result = 'error';
                throw error;
            } finally {
                end();
                cacheOperationsTotal.inc({
                    cache_op: 'deletePattern',
                    result,
                    db,
                });
            }
        },
    };
}
