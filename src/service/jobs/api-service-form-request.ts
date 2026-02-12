import axios from 'axios';
import { createApiServiceURL } from './api-service-request';
import logger from '@ondc/automation-logger';
import { QueueJob } from '../../queue/IQueueService';
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
            const res = await axios.post(url, body);
            return {
                success: true,
                statusCode: res.status,
                responseBody: res.data,
            };
        } catch (error) {
            logger.error('API service form request failed', { error });
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

export function apiServiceFormRequestJobComplete(
    job: QueueJob<ApiServiceFormRequestJobParams>,
    result?: unknown
): void {
    logger.info('API service form request job completed', {
        jobId: job?.id,
        result,
    });
}

export function apiServiceFormRequestJobFailed(
    job: QueueJob<ApiServiceFormRequestJobParams>,
    result: unknown,
    error?: Error
): void {
    logger.error('API service form request job failed', {
        jobId: job?.id,
        error,
    });
}
