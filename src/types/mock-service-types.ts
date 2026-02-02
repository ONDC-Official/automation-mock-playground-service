import { z } from 'zod';

export const MockSessionCacheSchema = z
    .object({
        MORE_SEQUENCE: z.array(z.any()).optional(), // or properly type the SequenceStep schema
        user_inputs: z.record(z.string(), z.any()).optional(),
        // Add other properties as needed
    })
    .loose();

export type MockSessionCache = z.infer<typeof MockSessionCacheSchema>;

export type SaveDataConfig = {
    'save-data': Record<string, string>;
};
export const MockFlowStatusCacheSchema = z.object({
    status: z.enum(['WORKING', 'AVAILABLE', 'SUSPENDED']),
});

export type MockFlowStatusCache = z.infer<typeof MockFlowStatusCacheSchema>;

export type MockStatusCode = MockFlowStatusCache['status'];
