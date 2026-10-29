import axios from 'axios';
import { IQueueService, QueueJob } from '../../queue/IQueueService';
import logger from '../../utils/logger';
import { setTraceContext } from '../../utils/trace-context';
import { isFdDomain } from '../../fd/constants';
import { FdSendMeta, fdSendHeaders } from '../../fd/outgoing';
import { handleFdSyncAnswer } from '../../fd/sync-answer';
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
            const isFd = isFdDomain(data.domain);
            const res = await axios.post(url, data.payload, {
                params: {
                    ...data.queryParams,
                },
                ...(isFd ? { headers: fdSendHeaders(data.fd) } : {}),
            });
            if (isFd) {
                await afterFdSend(deps, data, res.status, res.data);
            }
            return {
                success: true,
                statusCode: res.status,
                responseBody: res.data,
            };
        } catch (error) {
            logger.error('API service request failed', {}, { error });
            if (
                isFdDomain(data.domain) &&
                axios.isAxiosError(error) &&
                error.response
            ) {
                await afterFdSend(
                    deps,
                    data,
                    error.response.status,
                    error.response.data
                );
            }
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
 * FD: when the workbench called an NP's SYNC action, the response is the NP's answer. Failures
 * here are logged, never turned into a send failure.
 */
async function afterFdSend(
    deps: ApiServiceRequestJobDeps | undefined,
    data: ApiServiceRequestJobParams,
    status: number,
    body: unknown
): Promise<void> {
    const sync = data.fd?.syncAnswer;
    if (!sync || data.fd?.replay) return;
    if (!deps) {
        logger.error('FD SYNC answer not observed: send job has no caches', {
            action: data.action,
        });
        return;
    }
    try {
        await handleFdSyncAnswer(
            deps,
            sync,
            { action: data.action, pathParams: data.fd?.pathParams ?? {} },
            { status, body }
        );
    } catch (error) {
        logger.error(
            'FD SYNC answer could not be observed',
            { action: data.action, transactionId: sync.key.transactionId },
            error
        );
    }
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
