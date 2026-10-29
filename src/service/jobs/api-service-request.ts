import axios from 'axios';
import { IQueueService, QueueJob } from '../../queue/IQueueService';
import logger from '../../utils/logger';
import { setTraceContext } from '../../utils/trace-context';
import { isFdDomain } from '../../fd/constants';
import { FdSendMeta, fdSendHeaders } from '../../fd/outgoing';
import { handleFdSyncAnswer } from '../../fd/sync-answer';
import { FdReceipt, observeFdReceipts } from '../../fd/receipts';
import { scheduleFdAdvance } from '../../fd/advance';
import { FD_STATE_TTL_SECONDS } from '../../fd/constants';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';

export const SEND_TO_API_SERVICE_JOB = 'SEND_TO_API_SERVICE_JOB';

export type ApiServiceRequestJobParams = {
    action: string;
    domain: string;
    version: string;
    payload: unknown;
    subscriberUrl: string;
    queryParams?: Record<string, string>;
    /** FD (ONDC:FIS14:FD) only: internal headers and the SYNC-answer hook. */
    fd?: FdSendMeta;
};

export type ApiServiceRequestJobResult = {
    success: boolean;
    statusCode?: number;
    responseBody?: unknown;
};

/** Needed by the FD branch only (to observe a SYNC answer); Beckn sends never use them. */
export type ApiServiceRequestJobDeps = {
    workbenchCache: WorkbenchCacheServiceType;
    queue: IQueueService;
};

export function createApiServiceRequestJobHandler(
    deps?: ApiServiceRequestJobDeps
) {
    return async (data: ApiServiceRequestJobParams) => {
        setTraceContext({
            action: data.action,
            domain: data.domain,
            version: data.version,
            flowId: data.queryParams?.flow_id,
            sessionId: data.queryParams?.session_id,
        });
        try {
            const url = createApiServiceURL(
                data.version,
                `mock/${data.action}`,
                data.domain
            );
            logger.info('Sending request to API service', {
                url,
                queryParams: data.queryParams,
            });
            if (isFdDomain(data.domain)) return await sendFd(deps, data, url);
            const res = await axios.post(url, data.payload, {
                params: {
                    ...data.queryParams,
                },
            });
            return {
                success: true,
                statusCode: res.status,
                responseBody: res.data,
            };
        } catch (error) {
            logger.error('API service request failed', {}, { error });
            if (!axios.isAxiosError(error)) {
                return {
                    success: false,
                    message: 'Unknown error occurred',
                };
            }
            return {
                success: false,
                statusCode: error.response?.status,
                responseBody: error.response?.data,
            };
        }
    };
}

/**
 * FD: the body is sent as text the job serialises itself (or a stored original, for a
 * byte-identical re-send), so the exact bytes can be kept for a later replay. A step with
 * `deliveries: n` sends the same text n times concurrently (scenario 12).
 */
async function sendFd(
    deps: ApiServiceRequestJobDeps | undefined,
    data: ApiServiceRequestJobParams,
    url: string
): Promise<ApiServiceRequestJobResult> {
    const raw = data.fd?.rawBody ?? JSON.stringify(data.payload);
    const copies = Math.max(1, data.fd?.deliveries ?? 1);
    const deliver = async (): Promise<FdReceipt> => {
        try {
            const res = await axios.post(url, raw, {
                params: { ...data.queryParams },
                headers: {
                    ...fdSendHeaders(data.fd),
                    'Content-Type': 'application/json',
                },
            });
            return {
                status: res.status,
                body: res.data,
                headers: { ...res.headers },
            };
        } catch (error) {
            logger.error('API service request failed', {}, { error });
            if (axios.isAxiosError(error) && error.response) {
                return {
                    status: error.response.status,
                    body: error.response.data,
                    headers: { ...error.response.headers },
                };
            }
            return { error: (error as Error).message };
        }
    };
    const receipts = await Promise.all(
        Array.from({ length: copies }, () => deliver())
    );
    if (copies > 1) {
        logger.info('FD: delivered concurrently', {
            action: data.action,
            deliveries: receipts.map(r => r.status ?? r.error),
        });
    }
    const accepted = receipts.some(
        r => r.status !== undefined && r.status >= 200 && r.status < 300
    );
    if (accepted && !data.fd?.rawBody) await rememberFdSent(deps, data, raw);
    await afterFdSend(deps, data, receipts);
    const first = receipts[0];
    if (first.status !== undefined && first.status < 300) {
        return {
            success: true,
            statusCode: first.status,
            responseBody: first.body,
        };
    }
    return {
        success: false,
        statusCode: first.status,
        responseBody: first.body,
    };
}

/**
 * FD: when the workbench called an NP's SYNC action, the response is the NP's answer. Any
 * other FD send (a callback, a webhook, a workbench request) gets the NP's acknowledgement,
 * which the engine judges (every receipt, when the step delivered it more than once); an
 * accepted send moves the flow on once the recorder has its entry, so a workbench step that
 * follows (a webhook after a callback) is sent without anyone pressing proceed: a certification
 * run is unattended. Failures here are logged, never turned into a send failure.
 */
async function afterFdSend(
    deps: ApiServiceRequestJobDeps | undefined,
    data: ApiServiceRequestJobParams,
    receipts: FdReceipt[]
): Promise<void> {
    if (data.fd?.replay) return;
    if (!deps) {
        logger.error('FD send not followed up: send job has no caches', {
            action: data.action,
        });
        return;
    }
    const sync = data.fd?.syncAnswer;
    if (!sync) {
        try {
            await observeFdReceipts(
                deps.workbenchCache,
                {
                    action: data.action,
                    domain: data.domain,
                    version: data.version,
                    subscriberUrl: data.subscriberUrl,
                    payload: data.payload,
                    pathParams: data.fd?.pathParams ?? {},
                },
                receipts
            );
        } catch (error) {
            logger.error(
                'FD receipts could not be observed',
                { action: data.action },
                error
            );
        }
        if (
            receipts.some(
                r => r.status !== undefined && r.status >= 200 && r.status < 300
            )
        ) {
            advanceAfterSend(deps, data);
        }
        return;
    }
    const first = receipts[0];
    if (first?.status === undefined) return;
    try {
        await handleFdSyncAnswer(
            deps,
            sync,
            { action: data.action, pathParams: data.fd?.pathParams ?? {} },
            { status: first.status, body: first.body }
        );
    } catch (error) {
        logger.error(
            'FD SYNC answer could not be observed',
            { action: data.action, transactionId: sync.key.transactionId },
            error
        );
    }
}

/** Keeps the exact text of an FD message the API service accepted, for a later replay. */
async function rememberFdSent(
    deps: ApiServiceRequestJobDeps | undefined,
    data: ApiServiceRequestJobParams,
    raw: string
): Promise<void> {
    if (!deps || data.fd?.replay) return;
    const context = (data.payload as { context?: Record<string, unknown> })
        ?.context;
    const transactionId = context?.transaction_id;
    const messageId = context?.message_id;
    if (typeof transactionId !== 'string' || typeof messageId !== 'string') {
        return;
    }
    try {
        await deps.workbenchCache
            .FdCacheService()
            .setSentRaw(
                transactionId,
                data.subscriberUrl,
                messageId,
                raw,
                FD_STATE_TTL_SECONDS
            );
    } catch (error) {
        logger.error(
            'FD: could not keep the sent text for replays',
            { action: data.action, transactionId, messageId },
            error
        );
    }
}

function advanceAfterSend(
    deps: ApiServiceRequestJobDeps,
    data: ApiServiceRequestJobParams
): void {
    const context = (data.payload as { context?: Record<string, unknown> })
        ?.context;
    const transactionId = context?.transaction_id;
    const messageId = context?.message_id;
    if (typeof transactionId !== 'string' || typeof messageId !== 'string') {
        return;
    }
    void scheduleFdAdvance(deps, {
        transactionId,
        subscriberUrl: data.subscriberUrl,
        messageId,
    });
}

export function apiServiceRequestJobComplete(
    job: QueueJob<ApiServiceRequestJobParams>,
    result?: unknown
): void {
    logger.info('API service request job completed', {
        jobId: job?.id,
        result,
    });
}

export function apiServiceRequestJobFailed(
    job: QueueJob<ApiServiceRequestJobParams>,
    result: unknown,
    error?: Error
): void {
    logger.error('API service request job failed', {
        jobId: job?.id,
        error,
    });
}

export function createApiServiceURL(
    version: string,
    path: string,
    domain: string
) {
    // const domain = process.env.DOMAIN;
    return `${process.env.API_SERVICE_URL}/${domain}/${version}/${path}`;
}
