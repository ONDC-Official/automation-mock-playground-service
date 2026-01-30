import { z } from 'zod';
import { FlowSchema } from './flow-types';

export const ApiDataSchema = z.object({
    entryType: z.literal('API'),
    action: z.string(),
    payloadId: z.string(),
    messageId: z.string(),
    response: z.unknown(),
    timestamp: z.string(),
});

export const FormApiTypeSchema = z.object({
    entryType: z.literal('FORM'),
    formType: z.enum(['HTML_FORM', 'RES_FORM', 'DYNAMIC_FORM']),
    formId: z.string(),
    submissionId: z.string().optional(),
    timestamp: z.string(),
    error: z.string().optional(),
});

export const HistoryTypeSchema = z.discriminatedUnion('entryType', [
    ApiDataSchema,
    FormApiTypeSchema,
]);

export const TransactionCacheSchema = z.object({
    sessionId: z.string().optional(),
    flowId: z.string(),
    latestAction: z.string(),
    latestTimestamp: z.string(),
    type: z.enum(['default', 'manual']),
    subscriberType: z.enum(['BAP', 'BPP']),
    messageIds: z.array(z.string()),
    apiList: z.array(HistoryTypeSchema),
});

export const SessionCacheSchema = z.object({
    transactionIds: z.array(z.string()),
    flowMap: z.record(z.string(), z.string().optional()),
    npType: z.enum(['BAP', 'BPP']),
    domain: z.string(),
    version: z.string(),
    subscriberId: z.string().optional(),
    subscriberUrl: z.string(),
    usecaseId: z.string(),
    env: z.enum(['STAGING', 'PRE-PRODUCTION']),
    flowConfigs: z.record(z.string(), FlowSchema),
});

export const ExpectationSchema = z.object({
    sessionId: z.string(),
    flowId: z.string(),
    expectedAction: z.string().optional(),
    expireAt: z.string(),
});

export const SubscriberCacheSchema = z.object({
    activeSessions: z.array(ExpectationSchema),
});

export type ApiData = z.infer<typeof ApiDataSchema>;
export type FormApiType = z.infer<typeof FormApiTypeSchema>;
export type HistoryType = z.infer<typeof HistoryTypeSchema>;
export type TransactionCache = z.infer<typeof TransactionCacheSchema>;
export type SessionCache = z.infer<typeof SessionCacheSchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;
export type SubscriberCache = z.infer<typeof SubscriberCacheSchema>;
