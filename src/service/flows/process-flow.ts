import { IQueueService } from '../../queue/IQueueService';
import { FlowContext } from '../../types/process-flow-types';
import logger from '@ondc/automation-logger';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import {
    GENERATE_PAYLOAD_JOB,
    GenerateMockPayloadJobParams,
} from '../jobs/generate-response';
import { getNextActionMetaData } from './flow-mapper';
import {
    API_SERVICE_FORM_REQUEST_JOB,
    ApiServiceFormRequestJobParams,
} from '../jobs/api-service-form-request';

export type ActionUponFlowResponse = {
    success: boolean;
    message?: string;
    data?: unknown;
    jobId?: string;
    inputs?: unknown;
};

export async function actOnFlowService(
    params: FlowContext,
    workbenchCache: WorkbenchCacheServiceType,
    queueService: IQueueService
): Promise<ActionUponFlowResponse> {
    const flowStatus = await workbenchCache
        .FlowStatusCacheService()
        .getFlowStatus(params.transactionId, params.subscriberUrl, {
            transactionId: params.transactionId,
            flowId: params.flowId,
            domain: params.domain,
            version: params.version,
        });
    if (flowStatus.status === 'SUSPENDED') {
        return {
            success: false,
            message: 'Flow is suspended, cannot process further',
        };
    }
    if (flowStatus.status === 'WORKING') {
        return {
            success: false,
            message: 'Flow is already being processed',
        };
    }
    const businessCache = await workbenchCache
        .TxnBusinessCacheService()
        .getMockSessionData(
            params.transactionId,
            params.subscriberUrl,
            params.sessionId
        );

    const latestMeta = getNextActionMetaData(
        params.transactionData,
        params.flow,
        flowStatus.status,
        businessCache
    );
    if (!latestMeta) {
        return {
            success: true,
            message: 'No further action required for the flow',
        };
    }
    if (latestMeta.status === 'INPUT-REQUIRED' && params.inputs === undefined) {
        return {
            success: true,
            message:
                'Please provide inputs in the proceed/new call to progress',
            inputs: latestMeta.input,
        };
    }

    if (latestMeta.actionType === 'HTML_FORM') {
        return {
            success: false,
            message:
                'FORM based actions are not supported, in playground mock service',
        };
    }

    if (
        latestMeta.status === 'RESPONDING' ||
        latestMeta.status === 'INPUT-REQUIRED' ||
        latestMeta.status === 'WAITING-SUBMISSION'
    ) {
        await workbenchCache
            .FlowStatusCacheService()
            .setFlowStatus(
                params.transactionId,
                params.subscriberUrl,
                'WORKING'
            );

        if (latestMeta.actionType === 'DYNAMIC_FORM') {
            if (
                !params.inputs ||
                (params.inputs as Record<string, unknown>).submission_id ===
                    undefined
            ) {
                throw new Error(
                    'submission_id is required in inputs to proceed dynamic form'
                );
            }
            const submissionId = (params.inputs as Record<string, unknown>)
                .submission_id as string;

            await workbenchCache
                .TxnBusinessCacheService()
                .addFormSubmissionId(
                    params.transactionId,
                    params.subscriberUrl,
                    params.transactionData.sessionId!,
                    latestMeta.actionId,
                    submissionId
                );
            const formParams: ApiServiceFormRequestJobParams = {
                domain: params.domain,
                version: params.version,
                subscriberUrl: params.subscriberUrl,
                transactionId: params.transactionId,
                formActionId: latestMeta.actionId,
                formType: 'DYNAMIC_FORM',
                submissionId: submissionId,
            };
            const jobId = await queueService.enqueue(
                API_SERVICE_FORM_REQUEST_JOB,
                formParams
            );
            return {
                success: true,
                message: 'Form submission received, sending to API service',
                jobId,
            };
        }
        businessCache.user_inputs = params.inputs as Record<string, unknown>;
        logger.info(
            `Enqueuing job to generate payload for transaction: ${params.transactionId}`
        );
        const queParams: GenerateMockPayloadJobParams = {
            flowContext: params,
            inputs: params.inputs,
            actionMeta: latestMeta,
        };
        const jobId = await queueService.enqueue(
            GENERATE_PAYLOAD_JOB,
            queParams
        );
        return {
            success: true,
            message: 'server is now responding with the mock data',
            jobId,
        };
    } else if (latestMeta.status === 'LISTENING') {
        if (latestMeta.expect && params.transactionData.sessionId) {
            await workbenchCache
                .SubscriberCacheService()
                .createExpectation(
                    params.subscriberUrl,
                    params.flowId,
                    params.transactionData.sessionId,
                    latestMeta.actionType
                );
        }
        return {
            success: true,
            message: 'Mock Service is now listening for the next action',
        };
    }
    return {
        success: true,
        message: 'Flow processed successfully',
    };
}
