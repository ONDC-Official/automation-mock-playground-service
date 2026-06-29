import { IQueueService, QueueJob } from '../../queue/IQueueService';
import { MappedStep } from '../../types/mapped-flow-types';
import { FlowContext } from '../../types/process-flow-types';
import { MockRunnerConfigCache } from '../cache/config-cache';
import logger from '../../utils/logger';
import { setTraceContext } from '../../utils/trace-context';
import {
    ApiServiceRequestJobParams,
    SEND_TO_API_SERVICE_JOB,
} from './api-service-request';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { getSaveDataConfig } from '../../utils/runner-utils';
import { buildErrorPayload } from '../../utils/build-error-payload';

export const GENERATE_PAYLOAD_JOB = 'GENERATE_PAYLOAD_JOB';

export type GenerateMockPayloadJobParams = {
    flowContext: FlowContext;
    inputs?: unknown;
    actionMeta: MappedStep;
};

export type GenerateMockPayloadJobResult = {
    success: boolean;
    message: string;
    payload?: unknown;
};

type MeetRequirementsResult = {
    valid?: boolean;
    code?: number;
    description?: string;
};

/**
 * Free a step back to AVAILABLE so it can be re-dispatched after a failure.
 * Extra steps carry a per-step status; sequence steps use the flow-level status.
 * Without this an errored step stays WORKING until its TTL, and re-triggering
 * fails with "step ... is WORKING, cannot dispatch".
 */
async function resetFlowStatusToAvailable(
    workbenchCache: WorkbenchCacheServiceType,
    flowContext: FlowContext,
    actionMeta: MappedStep
): Promise<void> {
    try {
        const flowStatusService = workbenchCache.FlowStatusCacheService();
        if (actionMeta.isExtraStep === true) {
            await flowStatusService.setExtraFlowStatus(
                flowContext.transactionId,
                flowContext.subscriberUrl,
                actionMeta.actionId,
                'AVAILABLE'
            );
        } else {
            await flowStatusService.setFlowStatus(
                flowContext.transactionId,
                flowContext.subscriberUrl,
                'AVAILABLE'
            );
        }
    } catch (e) {
        logger.error(
            'Failed to reset flow status to AVAILABLE',
            {
                transactionId: flowContext.transactionId,
                flowId: flowContext.flowId,
                actionId: actionMeta.actionId,
            },
            e as Error
        );
    }
}

export function createGeneratePayloadJobHandler(
    workbenchCache: WorkbenchCacheServiceType,
    configCache: MockRunnerConfigCache
) {
    return async (data: GenerateMockPayloadJobParams) => {
        const { flowContext, actionMeta } = data;
        setTraceContext({
            transactionId: flowContext.transactionId,
            sessionId: flowContext.sessionId,
            flowId: flowContext.flowId,
            domain: flowContext.domain,
            version: flowContext.version,
            action: actionMeta.actionType,
            actionId: actionMeta.actionId,
        });
        const logMeta = {
            transactionId: flowContext.transactionId,
            flowId: flowContext.flowId,
            domain: flowContext.domain,
            version: flowContext.version,
            actionId: actionMeta.actionId,
        };

        // On any generation failure, free the step back to AVAILABLE so it can be
        // re-dispatched.
        const resetStatusToAvailable = () =>
            resetFlowStatusToAvailable(workbenchCache, flowContext, actionMeta);

        try {
            const mockRunner = await configCache.getRunnerInstance(
                flowContext.domain,
                flowContext.version,
                flowContext.flowId,
                flowContext.apiSessionCache.usecaseId,
                flowContext.transactionData.sessionId
            );

            const txnMockData = await workbenchCache
                .TxnBusinessCacheService()
                .getMockSessionData(
                    flowContext.transactionId,
                    flowContext.subscriberUrl,
                    flowContext.sessionId
                );
            txnMockData.user_inputs = data.inputs as
                | Record<string, unknown>
                | undefined;

            if (flowContext.apiSessionCache.npType === 'BAP') {
                txnMockData.bapUri = flowContext.subscriberUrl;
            } else {
                txnMockData.bppUri = flowContext.subscriberUrl;
            }

            // Echo the request's message_id for solicited callbacks (on_X). MockRunner derives
            // the echoed id from sessionData.latestMessage_id, but that is the MOST-RECENT
            // message — it gets clobbered by interleaving unsolicited on_status, and in w2w the
            // request is recorded on the counterparty subscriber_url partition. Resolve the
            // SPECIFIC predecessor's message_id from the full per-action transaction history
            // (across both subscriber_url partitions) and pin it as latestMessage_id so
            // on_confirm/on_search/on_init echo their exact request regardless of interleaving
            // or which w2w side generated the callback. The request step is the one whose `pair`
            // points at this callback; its `type` is the predecessor protocol action.
            try {
                const requestStep = flowContext.flow.sequence.find(
                    (s) => s.pair === actionMeta.actionId
                );
                const predecessorAction = requestStep?.type;
                if (predecessorAction) {
                    const partitionUrls = new Set<string>([
                        flowContext.subscriberUrl,
                    ]);
                    if (flowContext.subscriberUrl.includes('/buyer')) {
                        partitionUrls.add(
                            flowContext.subscriberUrl.replace('/buyer', '/seller')
                        );
                    } else if (flowContext.subscriberUrl.includes('/seller')) {
                        partitionUrls.add(
                            flowContext.subscriberUrl.replace('/seller', '/buyer')
                        );
                    }
                    let predecessorMessageId: string | undefined;
                    let predecessorTs = '';
                    for (const url of partitionUrls) {
                        try {
                            const txnData = await workbenchCache
                                .TransactionalCacheService()
                                .getTransactionData(
                                    flowContext.transactionId,
                                    url
                                );
                            for (const item of txnData.apiList ?? []) {
                                if (
                                    item.entryType === 'API' &&
                                    item.action === predecessorAction &&
                                    (item.timestamp ?? '') >= predecessorTs
                                ) {
                                    predecessorMessageId = item.messageId;
                                    predecessorTs = item.timestamp ?? '';
                                }
                            }
                        } catch {
                            // partition may not exist for this subscriber_url; ignore
                        }
                    }
                    if (predecessorMessageId) {
                        txnMockData.latestMessage_id = [predecessorMessageId];
                        logger.debug(
                            'Pinned predecessor message_id for callback echo',
                            {
                                ...logMeta,
                                predecessorAction,
                                predecessorMessageId,
                            }
                        );
                    }
                }
            } catch (err) {
                logger.warning(
                    'Predecessor message_id resolution failed; falling back to default generation',
                    logMeta,
                    err as Error
                );
            }

            const finvuUrl = process.env.FINVU_AA_SERVICE_URL;
            if (finvuUrl) {
                txnMockData.finvuUrl = finvuUrl;
            }

            if (process.env.SKIP_MEETS_REQUIRMENTS === 'true') {
                logger.info(
                    'Skipping meet requirements check (SKIP_MEETS_REQUIRMENTS=true)',
                    logMeta
                );
            } else {
                const meetOutput =
                    await mockRunner.runMeetRequirementsWithSession(
                        actionMeta.actionId,
                        txnMockData
                    );
                if (meetOutput.success === false) {
                    logger.error(
                        'Meet requirements execution failed',
                        logMeta,
                        meetOutput.error
                    );
                    await resetStatusToAvailable();
                    return {
                        success: true,
                        message:
                            'Requirements check errored, proceeding with error payload',
                        payload: buildErrorPayload(
                            flowContext,
                            actionMeta,
                            'REQUIREMENTS_CHECK_ERROR',
                            '[MOCK PAYLOAD GENERATION ERROR] PLEASE CONTACT TECH SUPPORT',
                            meetOutput.error?.message ??
                                'Requirements check failed',
                            meetOutput.error?.stack ??
                                'Stack trace not available'
                        ),
                    };
                }

                const reqResult = meetOutput.result as
                    | MeetRequirementsResult
                    | undefined;
                if (reqResult?.valid === false) {
                    logger.info('Requirements not met for action', {
                        ...logMeta,
                        code: reqResult.code,
                        description: reqResult.description,
                    });
                    return {
                        success: true,
                        message:
                            'Requirements not met, proceeding with error payload',
                        payload: buildErrorPayload(
                            flowContext,
                            actionMeta,
                            'REQUIREMENTS_NOT_MET',
                            reqResult.description ?? 'Requirements not met',
                            reqResult.description ?? 'Requirements not met',
                            `code=${reqResult.code ?? 'N/A'} description=${reqResult.description ?? 'N/A'}`
                        ),
                    };
                }
            }

            const genOutput = await mockRunner.runGeneratePayloadWithSession(
                actionMeta.actionId,
                txnMockData
            );
            if (genOutput.success === false) {
                logger.error(
                    'Mock payload generation failed',
                    { ...logMeta, result: genOutput },
                    genOutput.error
                );
                await resetStatusToAvailable();
                return {
                    success: true,
                    message:
                        'Mock payload generation failed, but proceeding with payload with error details',
                    payload: buildErrorPayload(
                        flowContext,
                        actionMeta,
                        'GENERATION_ERROR',
                        '[MOCK PAYLOAD GENERATION ERROR] PLEASE CONTACT TECH SUPPORT',
                        genOutput.error?.message ??
                            'Error details not available',
                        genOutput.error?.stack ?? 'Stack trace not available'
                    ),
                };
            }

            if (genOutput.result === undefined) {
                logger.error('Generated payload is undefined', logMeta);
                throw new Error('Generated payload is undefined');
            }

            logger.debug('Generated mock payload', logMeta);
            return {
                success: true,
                message: 'Payload generated successfully',
                payload: genOutput.result,
            };
        } catch (error) {
            logger.error('Error generating mock payload', logMeta, error);
            await resetStatusToAvailable();
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
                    session_id: job.data.flowContext.sessionId,
                },
            };
            const mockRunnerConfig = await mockRunnerCache.getMockRunnerConfig(
                job.data.flowContext.domain,
                job.data.flowContext.version,
                job.data.flowContext.flowId,
                job.data.flowContext.apiSessionCache.usecaseId,
                job.data.flowContext.sessionId
            );
            const saveDataConfig = getSaveDataConfig(
                mockRunnerConfig,
                job.data.actionMeta.actionId
            );
            await workbenchCache.TxnBusinessCacheService().saveMockSessionData(
                job.data.flowContext.transactionId,
                job.data.flowContext.subscriberUrl,
                payload,
                {
                    'save-data': saveDataConfig,
                },
                job.data.flowContext.sessionId
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

            // Extra steps are repeatable side-channel sends (e.g. the ride-map driver moves /
            // state changes). Once the payload is generated and the send is enqueued, free the
            // step back to AVAILABLE so it can be re-triggered immediately. Sequence steps are
            // left WORKING (they clear when the API service acks the response).
            if (job.data.actionMeta.isExtraStep === true) {
                await resetFlowStatusToAvailable(
                    workbenchCache,
                    job.data.flowContext,
                    job.data.actionMeta
                );
            }
        } catch (error) {
            logger.error('Error in processing generated payload', {}, error);
            // The request never reached the api service, so it won't write
            // AVAILABLE back. Free the step here or it stays WORKING until TTL
            // and re-dispatch fails with "step ... is WORKING, cannot dispatch".
            await resetFlowStatusToAvailable(
                workbenchCache,
                job.data.flowContext,
                job.data.actionMeta
            );
        }
    };
}
