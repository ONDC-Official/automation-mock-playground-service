import { NextFunction, Response } from 'express';
import { ApiRequest } from '../routes/manualRoutes';
import { MockRunnerConfigCache } from '../service/cache/config-cache';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import {
    InternalServerError,
    normalizeError,
    OndcProtocolError,
} from '../errors/custom-errors';
import { logError } from '../utils/req-utils';
import { getFlowCompleteStatus } from '../service/flows/flow-mapper';
import { getLoggerData } from '../utils/logger/winston/loggerUtils';
import { MappedStep } from '../types/mapped-flow-types';
import logger from '../utils/logger';
import { FlowContext } from '../types/process-flow-types';
import MockRunner from '@ondc/automation-mock-runner';
import { IQueueService } from '../queue/IQueueService';
import {
    ApiServiceRequestJobParams,
    SEND_TO_API_SERVICE_JOB,
} from '../service/jobs/api-service-request';
import { sendAck } from '../utils/res-utils';

export function incomingRequestControllers(
    workbenchCache: WorkbenchCacheServiceType,
    mockRunnerCache: MockRunnerConfigCache,
    queue: IQueueService
) {
    return {
        validateAndSaveIncomingRequest: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {
            try {
                if (!req.flowContext) {
                    throw new InternalServerError(
                        '[DEFECT] Flow context is missing in the request'
                    );
                }
                const ctx = req.flowContext;
                const payload = req.body;
                const flowStatus = await workbenchCache
                    .FlowStatusCacheService()
                    .getFlowStatus(
                        ctx.transactionId,
                        ctx.subscriberUrl,
                        getLoggerData(req)
                    );
                const mockSessionData = await workbenchCache
                    .TxnBusinessCacheService()
                    .getMockSessionData(ctx.transactionId, ctx.subscriberUrl);
                const flowStatusComplete = getFlowCompleteStatus(
                    ctx.transactionData,
                    ctx.flow,
                    flowStatus.status,
                    mockSessionData
                );
                const matchingStep = await findMatchingStep(
                    flowStatusComplete.sequence,
                    payload
                );
                if (!matchingStep) {
                    logger.warning(
                        'No matching step found for the incoming request',
                        getLoggerData(req)
                    );
                    next();
                    return;
                }

                const processRequest = await processMatchingRequest(
                    matchingStep,
                    payload,
                    mockSessionData,
                    ctx.subscriberUrl,
                    req,
                    ctx,
                    queue,
                    mockRunnerCache
                );

                if (processRequest?.shouldRespond === false) {
                    sendAck(res, payload.context);
                    return;
                }
                next();
            } catch (error) {
                logError(req, 'incoming request failed', error);
                next(
                    normalizeError(
                        error,
                        new OndcProtocolError(
                            '31001',
                            'Error acting upon flow',
                            'Unknown error'
                        )
                    )
                );
            }
        },
    };
}

async function findMatchingStep(
    sequence: MappedStep[],
    body: Record<string, unknown>
) {
    for (const step of sequence) {
        const data = step.payloads;
        if (
            !data ||
            data.entryType === 'FORM' ||
            step.actionType === 'HTML_FORM'
        ) {
            continue;
        }
        if (data && data.payloads.length > 0) {
            const uniqueKey = `${data.action}::${data.messageId}::${data.timestamp}`;
            const context = body.context as {
                action: string;
                message_id: string;
                timestamp: string;
            };
            const requestKey = `${context.action}::${context.message_id}::${context.timestamp}`;
            if (uniqueKey === requestKey) {
                return { step, index: sequence.indexOf(step) };
            }
        }
    }
    return null;
}

async function processMatchingRequest(
    matchingStep: { step: MappedStep; index: number },
    body: Record<string, unknown>,
    mockSessionData: Record<string, unknown>,
    subscriberUrl: string,
    req: ApiRequest,
    ctx: FlowContext,
    queue: IQueueService,
    mockRunnerCache: MockRunnerConfigCache
) {
    const { step, index } = matchingStep;
    logger.info(
        `Processing matching step: ${step.actionId} at index ${index}`,
        getLoggerData(req)
    );
    try {
        const runnerConfig = await mockRunnerCache.getMockRunnerConfig(
            ctx.domain,
            ctx.version,
            ctx.flowId
        );
        const mockRunner = new MockRunner(runnerConfig);
        const validationResult = (
            await mockRunner.runValidatePayloadWithSession(
                step.actionId,
                body,
                mockSessionData
            )
        ).result as {
            valid: boolean;
            code?: string;
            description?: string;
        };
        if (!validationResult.valid) {
            logger.error(
                `Payload validation failed for action ${step.actionId}: ${validationResult.code} - ${validationResult.description}`,
                getLoggerData(req)
            );
            await handleValidationFailure(
                validationResult,
                step,
                body,
                subscriberUrl,
                queue,
                ctx
            );
            return { shouldRespond: false };
        }
    } catch (error) {
        logger.error(
            'Error while validating and saving ' + step.actionId,
            getLoggerData(req),
            error
        );
        return { shouldRespond: false };
    }
}

async function handleValidationFailure(
    validationResult: { code?: string; message?: string },
    step: MappedStep,
    body: Record<string, unknown>,
    subsUrl: string,
    queue: IQueueService,
    ctx: FlowContext
) {
    logger.info(
        `Validation failed for action: ${step.actionId}, Message: ${validationResult.message}`
    );

    const action = step.actionType.startsWith('on_')
        ? step.actionType.slice(3)
        : `on_${step.actionType}`;

    const context = body.context as any;

    const errBody = {
        context: {
            ...context,
            action: action,
            timestamp: new Date().toISOString(),
        },
        error: {
            code: validationResult.code || 'VALIDATION_ERROR',
            message: validationResult.message || 'Validation failed',
        },
    };

    const data: ApiServiceRequestJobParams = {
        action: action,
        domain: ctx.domain,
        version: ctx.version,
        payload: errBody,
        subscriberUrl: subsUrl,
        queryParams: {
            flow_id: ctx.flowId,
            session_id: ctx.transactionData.sessionId || '',
            subscriber_url: subsUrl,
        },
    };
    queue.enqueue(SEND_TO_API_SERVICE_JOB, data);
}
