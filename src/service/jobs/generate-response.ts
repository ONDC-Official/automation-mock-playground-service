import MockRunner from '@ondc/automation-mock-runner';
import { IQueueService, QueueJob } from '../../queue/IQueueService';
import { MappedStep } from '../../types/mapped-flow-types';
import { FlowContext } from '../../types/process-flow-types';
import { MockRunnerConfigCache } from '../cache/config-cache';
import logger from '../../utils/logger';
import {
    ApiServiceRequestJobParams,
    SEND_TO_API_SERVICE_JOB,
} from './api-service-request';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { getSaveDataConfig } from '../../utils/runner-utils';

export const GENERATE_PAYLOAD_JOB = 'GENERATE_PAYLOAD_JOB';

export type GenerateMockPayloadJobParams = {
    flowContext: FlowContext;
    businessDataWithInputs: unknown;
    actionMeta: MappedStep;
};

export type GenerateMockPayloadJobResult = {
    success: boolean;
    message: string;
    payload?: unknown;
};

export function createGeneratePayloadJobHandler(
    workbenchCache: WorkbenchCacheServiceType,
    configCache: MockRunnerConfigCache
) {
    return async (data: GenerateMockPayloadJobParams) => {
        try {
            const { flowId, domain, version } = data.flowContext;
            const mockConfig = await configCache.getMockRunnerConfig(
                domain,
                version,
                flowId,
                data.flowContext.apiSessionCache.usecaseId
            );
            logger.debug('Fetched mock runner config', {
                transactionId: data.flowContext.transactionId,
                flowId: data.flowContext.flowId,
                domain: data.flowContext.domain,
                version: data.flowContext.version,
            });
            const mockRunner = new MockRunner(mockConfig);
            logger.debug('Initialized mock runner', {
                actionID: data.actionMeta.actionId,
                sessionData: JSON.stringify(data.businessDataWithInputs),
            });
            const genOutput = await mockRunner.runGeneratePayloadWithSession(
                data.actionMeta.actionId,
                data.businessDataWithInputs
            );
            const payload = genOutput.result;
            if (payload === undefined) {
                logger.debug('Generated payload is undefined', {
                    config: JSON.stringify(mockConfig),
                });
                throw new Error('Generated payload is undefined');
            }
            logger.debug('Generated mock payload', {
                transactionId: data.flowContext.transactionId,
                flowId: data.flowContext.flowId,
            });
            return {
                success: true,
                message: 'Payload generated successfully',
                payload,
            };
        } catch (error) {
            logger.error('Error generating mock payload', {}, error);
            workbenchCache
                .FlowStatusCacheService()
                .setFlowStatus(
                    data.flowContext.transactionId,
                    data.flowContext.subscriberUrl,
                    'AVAILABLE'
                );
            throw error;
        }
    };
}

export function generateRequestPayloadJobFailed(
    job: QueueJob<GenerateMockPayloadJobParams>,
    result: unknown,
    error?: Error
): void {
    logger.error(
        'Generate payload job failed',
        {
            jobId: job?.id,
            actionId: job?.data.actionMeta.actionId,
            transactionId: job?.data.flowContext.transactionId,
            flowId: job?.data.flowContext.flowId,
            result: result,
        },
        error
    );
}
export function createGenerationRequestCompleteHandler(
    queue: IQueueService,
    workbenchCache: WorkbenchCacheServiceType,
    mockRunnerCache: MockRunnerConfigCache
) {
    return async (
        job: QueueJob<GenerateMockPayloadJobParams>,
        result?: unknown
    ): Promise<void> => {
        try {
            logger.debug('Generate payload job completed', {
                jobId: job.id,
                jobName: job.jobName ?? 'N/A',
            });
            const parsedResult = result as GenerateMockPayloadJobResult;
            const payload = parsedResult?.payload;
            const params: ApiServiceRequestJobParams = {
                action: job.data.actionMeta.actionType,
                domain: job.data.flowContext.domain,
                version: job.data.flowContext.version,
                payload: payload ?? {},
                subscriberUrl: job.data.flowContext.subscriberUrl,
                queryParams: {
                    subscriber_url: job.data.flowContext.subscriberUrl,
                    flow_id: job.data.flowContext.flowId,
                    session_id:
                        job.data.flowContext.transactionData.sessionId ?? '',
                },
            };
            const mockRunnerConfig = await mockRunnerCache.getMockRunnerConfig(
                job.data.flowContext.domain,
                job.data.flowContext.version,
                job.data.flowContext.flowId,
                job.data.flowContext.apiSessionCache.usecaseId
            );
            const saveDataConfig = getSaveDataConfig(
                mockRunnerConfig,
                job.data.actionMeta.actionId
            );
            await workbenchCache
                .TxnBusinessCacheService()
                .saveMockSessionData(
                    job.data.flowContext.transactionId,
                    payload,
                    {
                        'save-data': saveDataConfig,
                    }
                );
            logger.info(
                'Successfully saved generated payload for action ' +
                    job.data.actionMeta.actionId,
                {
                    transactionId: job.data.flowContext.transactionId,
                    actionId: job.data.actionMeta.actionId,
                }
            );
            const id = await queue.enqueue(SEND_TO_API_SERVICE_JOB, params);
            logger.info('Enqueued API service request job', { jobId: id });
        } catch (error) {
            logger.error('Error in processing generated payload', {}, error);
        }
    };
}
