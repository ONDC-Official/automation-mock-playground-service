import { z } from 'zod';

export const clearFlowsQuerySchema = z.object({
    domain: z.string().min(1),
    version: z.string().optional(),
    flowId: z.string().optional(),
});

export type ClearFlowsQuery = z.infer<typeof clearFlowsQuerySchema>;

export interface ClearFlowsResult {
    message: string;
    description: string;
    deletedCount: number;
    pattern: string;
}
