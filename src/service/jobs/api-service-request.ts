import axios from 'axios';
import { QueueJob } from '../../queue/IQueueService';
import logger from '@ondc/automation-logger';

export const SEND_TO_API_SERVICE_JOB = 'SEND_TO_API_SERVICE_JOB';

export type ApiServiceRequestJobParams = {
    action: string;
    domain: string;
    version: string;
    payload: unknown;
    subscriberUrl: string;
    queryParams?: Record<string, string>;
};

export type ApiServiceRequestJobResult = {
    success: boolean;
    statusCode?: number;
    responseBody?: unknown;
};

export function createApiServiceRequestJobHandler() {
    return async (data: ApiServiceRequestJobParams) => {
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
            logger.error('API service request failed', { error });
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
