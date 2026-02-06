import { ICacheService } from './cache-interface';
import Redis from 'ioredis';
import { z } from 'zod';
import logger from '@ondc/automation-logger';

export function createRedisCacheService(redisClient: Redis): ICacheService {
    return {
        async get<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
            try {
                const raw = await redisClient.get(key);

                if (raw === null) {
                    return null;
                }

                const parsed = JSON.parse(raw);
                return schema.parse(parsed);
            } catch (error) {
                if (error instanceof z.ZodError) {
                    logger.error(
                        `Cache data validation failed for key: ${key}`,
                        {},
                        error
                    );
                    return null;
                }
                throw error;
            }
        },

        async set<T>(
            key: string,
            value: unknown,
            schema: z.ZodType<T>,
            ttlSeconds?: number
        ): Promise<void> {
            // Validate before caching
            const validated = schema.parse(value);
            const serialized = JSON.stringify(validated);

            if (ttlSeconds) {
                await redisClient.setex(key, ttlSeconds, serialized);
            } else {
                await redisClient.set(key, serialized);
            }
        },

        async delete(key: string): Promise<void> {
            await redisClient.del(key);
        },

        async exists(key: string): Promise<boolean> {
            const result = await redisClient.exists(key);
            return result === 1;
        },

        async deletePattern(pattern: string): Promise<number> {
            const keys = await redisClient.keys(pattern);
            if (keys.length === 0) {
                return 0;
            }
            return await redisClient.del(...keys);
        },
    };
}
