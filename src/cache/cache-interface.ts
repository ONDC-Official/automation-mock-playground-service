import { z } from 'zod';

export type ICacheService = {
    get<T>(key: string, schema: z.ZodType<T>): Promise<T | null>;

    set<T>(
        key: string,
        value: unknown,
        schema: z.ZodType<T>,
        ttlSeconds?: number
    ): Promise<void>;

    delete(key: string): Promise<void>;

    exists(key: string): Promise<boolean>;

    deletePattern(pattern: string): Promise<number>;
};
