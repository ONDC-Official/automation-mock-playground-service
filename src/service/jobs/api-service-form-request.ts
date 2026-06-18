import axios from 'axios';
import { obsAxios } from '../../observability/http-client';
import { createApiServiceURL } from './api-service-request';
import logger from '../../observability/log';
import { QueueJob } from '../../queue/IQueueService';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { resetStepToAvailable } from '../flows/flow-status-utils';
export const API_SERVICE_FORM_REQUEST_JOB = 'API_SERVICE_FORMS_JOB';

export type ApiServiceFormRequestJobParams = {
    domain: string;
    version: string;
    subscriberUrl: string;
    transactionId: string;
    formActionId: string;
    formType: string;
    submissionId?: string;
    error?: unknown;
};

export type ApiServiceFormRequestJobResult = {
    success: boolean;
    statusCode?: number;
    responseBody?: unknown;
};

export function createApiServiceFormRequestJobHandler() {
    return async (data: ApiServiceFormRequestJobParams) => {
        try {
            const url = createApiServiceURL(
                data.version,
                `form/html-form`,
                data.domain
            );
            logger.info('Sending form request to API service', {
                url,
                formType: data.formType,
            });
            const body = {
                context: {
                    version: data.version,
                    domain: data.domain,
                },
                subscriber_url: data.subscriberUrl,
                transaction_id: data.transactionId,
                form_action_id: data.formActionId,
                form_type: data.formType, // Include form type in request body
                submissionId: data.submissionId,
                error: data.error,
            };
            const res = await obsAxios.post(url, body);
            return {
                success: true,
                statusCode: res.status,
                responseBody: res.data,
            };
        } catch (error) {
            logger.error(
                'API service form request failed',
                {
                    event: 'error',
                    component: 'job',
                    job_name: API_SERVICE_FORM_REQUEST_JOB,
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
            throw error;
        }
    };
}

export function apiServiceFormRequestJobComplete(
    job: QueueJob<ApiServiceFormRequestJobParams>,
    result?: unknown
): void {
    logger.info('API service form request job completed', {
        jobId: job?.id,
        result,
    });
}

export function createApiServiceFormRequestJobFailed(
    workbenchCache: WorkbenchCacheServiceType
) {
    return async (
        job: QueueJob<ApiServiceFormRequestJobParams>,
        _result?: unknown,
        error?: Error
    ): Promise<void> => {
        logger.error(
            'API service form request job failed',
            {
                event: 'error',
                component: 'job',
                job_name: API_SERVICE_FORM_REQUEST_JOB,
                jobId: job?.id,
                transactionId: job?.data?.transactionId,
            },
            error
        );
        if (job?.data?.transactionId && job?.data?.subscriberUrl) {
            await resetStepToAvailable(workbenchCache, {
                transactionId: job.data.transactionId,
                subscriberUrl: job.data.subscriberUrl,
            });
        }
    };
}
