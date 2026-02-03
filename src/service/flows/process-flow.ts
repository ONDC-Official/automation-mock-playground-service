import { IQueueService } from '../../queue/IQueueService';
import { FlowContext } from '../../types/process-flow-types';
import logger from '../../utils/logger';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { getNextActionMetaData } from './flow-mapper';

export type ActionUponFlowResponse = {
    success: boolean;
    message?: string;
    data?: unknown;
    jobId?: string;
    inputs?: unknown;
};

export async function ActOnFlowService(
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
        .getMockSessionData(params.transactionId, params.subscriberUrl);

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

    if (
        latestMeta.actionType === 'HTML_FORM' ||
        latestMeta.actionType === 'DYNAMIC_FORM'
    ) {
        return {
            success: false,
            message:
                'FORM based actions are not supported, in playground mock service',
        };
    }

    if (
        latestMeta.status === 'RESPONDING' ||
        latestMeta.status === 'INPUT-REQUIRED'
    ) {
        businessCache.user_inputs = params.inputs as Record<string, unknown>;
        logger.info(
            `Enqueuing job to generate payload for transaction: ${params.transactionId}`
        );
        const jobId = await queueService.enqueue('GENERATE_PAYLOAD_JOB', {
            flowContext: params,
            businessData: businessCache,
            actionMeta: latestMeta,
        });
        return {
            success: true,
            message: 'server is not responding with the mock data',
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
