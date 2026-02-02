import z from 'zod';

export const getFlowStatusQuerySchema = z.object({
    transaction_id: z.string(),
    session_id: z.string(),
});
export type GetFlowStatusQuery = z.infer<typeof getFlowStatusQuerySchema>;

export const startNewFlowBodySchema = z.object({
    session_id: z.string(),
    flow_id: z.string(),
    transaction_id: z.string().optional(),
    inputs: z.any().optional(),
});

export type StartNewFlowBody = z.infer<typeof startNewFlowBodySchema>;

export const proceedWithFlowBodySchema = z.object({
    transaction_id: z.string(),
    session_id: z.string(),
    inputs: z.any().optional(),
});

export type ProceedWithFlowBody = z.infer<typeof proceedWithFlowBodySchema>;

export type MockRequest = {
    correlationId?: string;
    flowId?: string;
    transactionId?: string;
    subscriberUrl?: string;
    query: Record<string, unknown>;
    params: Record<string, unknown>;
    queryData?: Record<string, unknown>;
    transactionData?: {
        sessionId?: string;
    };
    body?: Record<string, unknown>;
};
