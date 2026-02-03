import { z } from 'zod';
import { ICacheService } from './cache-interface';

export function createCache(cacheType: 'redis' | 'mock'): ICacheService {
    if (cacheType === 'mock') return createMockCache();
    throw new Error(`Unsupported cache type: ${cacheType}`);
}

function createMockCache(): ICacheService {
    const mockData = new Map<string, unknown>();
    return {
        async get<T>(key: string, _schema: z.ZodType<T>): Promise<T | null> {
            if (mockData.has(key)) {
                return mockData.get(key) as T;
            }
            return null;
        },
        async set<T>(
            key: string,
            value: unknown,
            _schema: z.ZodType<T>,
            _ttlSeconds?: number
        ): Promise<void> {
            mockData.set(key, value);
        },
        async delete(key: string): Promise<void> {
            mockData.delete(key);
        },
        async exists(key: string): Promise<boolean> {
            return mockData.has(key);
        },
        async deletePattern(pattern: string): Promise<number> {
            const regex = new RegExp(
                '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            );
            let count = 0;
            for (const key of mockData.keys()) {
                if (regex.test(key)) {
                    mockData.delete(key);
                    count++;
                }
            }
            return count;
        },
    };
}
