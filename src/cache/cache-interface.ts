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

    /**
     * Atomically sets `key` to the raw string `value` (no schema, no JSON) for `ttlMs`, only if
     * it is absent; true when set. Optional: a cache without it offers no locking.
     */
    setIfAbsent?(key: string, value: string, ttlMs: number): Promise<boolean>;

    /** Atomically deletes `key` only while it still holds `value`; true when deleted. */
    deleteIfValue?(key: string, value: string): Promise<boolean>;
};
