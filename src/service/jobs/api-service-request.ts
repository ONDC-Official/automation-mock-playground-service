import axios from 'axios';
import { obsAxios } from '../../observability/http-client';
import { QueueJob } from '../../queue/IQueueService';
import logger from '../../observability/log';
import { set as setTrace } from '../../observability/trace-context';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { resetStepToAvailable } from '../flows/flow-status-utils';

export const SEND_TO_API_SERVICE_JOB = 'SEND_TO_API_SERVICE_JOB';

export type ApiServiceRequestJobParams = {
    action: string;
    domain: string;
    version: string;
    payload: unknown;
    subscriberUrl: string;
    // Identifiers needed to free the flow step on terminal failure.
    transactionId: string;
    flowId: string;
    actionId: string;
    isExtraStep?: boolean;
    queryParams?: Record<string, string>;
};

export type ApiServiceRequestJobResult = {
    success: boolean;
    statusCode?: number;
    responseBody?: unknown;
};

export function createApiServiceRequestJobHandler() {
    return async (data: ApiServiceRequestJobParams) => {
        setTrace({
            action: data.action,
            domain: data.domain,
            version: data.version,
            flow_id: data.queryParams?.flow_id,
            session_id: data.queryParams?.session_id,
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
            const res = await obsAxios.post(url, data.payload, {
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
            logger.error(
                'API service request failed',
                {
                    event: 'error',
                    component: 'job',
                    job_name: SEND_TO_API_SERVICE_JOB,
                    action: data.action,
                    domain: data.domain,
                    version: data.version,
                    statusCode: axios.isAxiosError(error)
                        ? error.response?.status
                        : undefined,
                },
                error
            );
            // Re-throw so the queue marks the job FAILED (firing on('failed') →
            // flow reset + failure metric) instead of silently completing.
            // A swallowed failure here leaves the flow stuck in WORKING.
            throw error;
        }
    };
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

export function createApiServiceRequestJobFailed(
    workbenchCache: WorkbenchCacheServiceType
) {
    return async (
        job: QueueJob<ApiServiceRequestJobParams>,
        _result?: unknown,
        error?: Error
    ): Promise<void> => {
        logger.error(
            'API service request job failed',
            {
                event: 'error',
                component: 'job',
                job_name: SEND_TO_API_SERVICE_JOB,
                jobId: job?.id,
                transactionId: job?.data?.transactionId,
                actionId: job?.data?.actionId,
            },
            error
        );
        if (job?.data?.transactionId && job?.data?.subscriberUrl) {
            await resetStepToAvailable(workbenchCache, {
                transactionId: job.data.transactionId,
                subscriberUrl: job.data.subscriberUrl,
                actionId: job.data.actionId,
                isExtraStep: job.data.isExtraStep,
            });
        }
    };
}

export function createApiServiceURL(
    version: string,
    path: string,
    domain: string
) {
    // const domain = process.env.DOMAIN;
    return `${process.env.API_SERVICE_URL}/${domain}/${version}/${path}`;
}
