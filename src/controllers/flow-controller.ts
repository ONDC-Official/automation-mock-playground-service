import { NextFunction, Response } from 'express';
import { IQueueService } from '../queue/IQueueService';
import { ApiRequest } from '../routes/manualRoutes';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import {
    getFlowStatusQuerySchema,
    proceedWithFlowBodySchema,
    startNewFlowBodySchema,
} from '../types/request-types';
import {
    httpValidationError,
    OndcProtocolError,
} from '../errors/custom-errors';
import logger from '../utils/logger';
import { getLoggerData } from '../utils/logger/winston/loggerUtils';
import { sendSuccess } from '../utils/res-utils';
import { getFlowCompleteStatus } from '../service/flows/flow-mapper';
import { randomUUID } from 'crypto';
import { fetchFlow } from '../utils/flow-utils';

export const flowControllers = (
    queueService: IQueueService,
    workbenchCache: WorkbenchCacheServiceType
) => {
    return {
        startNewFlowController: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {
            try {
                // Implementation for starting a new flow
                const body = req.body;
                const bodySchema = startNewFlowBodySchema;
                const parsedBody = bodySchema.safeParse(body);
                if (!parsedBody.success) {
                    next(
                        new httpValidationError('Invalid request body', [
                            parsedBody.error.message,
                        ])
                    );
                    return;
                }
                if (!parsedBody.data.transaction_id) {
                    parsedBody.data.transaction_id = randomUUID();
                }
                const { session_id, flow_id, transaction_id } = parsedBody.data;
                const sessionData = await workbenchCache
                    .NpSessionalCacheService()
                    .getSessionData(session_id);
                const flow = fetchFlow(sessionData, flow_id);
                req.flow = flow;
                req.flowId = flow_id;
                req.transactionId = transaction_id;
                req.subscriberUrl = sessionData.subscriberUrl;
                req.transactionData = {
                    latestAction: '',
                    latestTimestamp: '',
                    type: 'manual',
                    subscriberType: sessionData.npType,
                    flowId: flow_id,
                    sessionId: session_id,
                    messageIds: [],
                    apiList: [],
                };
                req.apiSessionCache = sessionData;
                req.inputs = parsedBody.data.inputs;
                req.domain = sessionData.domain;
                req.version = sessionData.version;
                next();
                return;
            } catch (error) {
                logger.error('Error in startNewFlowController', {}, error);
                next(
                    new OndcProtocolError(
                        '31001',
                        'Error starting new flow',
                        (error as Error)?.message ?? 'Unknown error'
                    )
                );
            }
        },
        proceedWithFlowController: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {
            try {
                const body = req.body;
                const bodySchema = proceedWithFlowBodySchema;
                const parsedBody = bodySchema.safeParse(body);
                if (!parsedBody.success) {
                    next(
                        new httpValidationError('Invalid request body', [
                            parsedBody.error.message,
                        ])
                    );
                    return;
                }
                const { transaction_id, session_id } = parsedBody.data;
                const sessionData = await workbenchCache
                    .NpSessionalCacheService()
                    .getSessionData(session_id);
                const transactionData = await workbenchCache
                    .TransactionalCacheService()
                    .getTransactionData(
                        transaction_id,
                        sessionData.subscriberUrl
                    );
                const flow = fetchFlow(sessionData, transactionData.flowId);
                req.flow = flow;
                req.flowId = transactionData.flowId;
                req.transactionId = transaction_id;
                req.subscriberUrl = sessionData.subscriberUrl;
                req.transactionData = transactionData;
                req.apiSessionCache = sessionData;
                req.inputs = parsedBody.data.inputs;
                req.domain = sessionData.domain;
                req.version = sessionData.version;
                next();
                return;
            } catch (error) {
                logger.error('Error in proceedWithFlowController', {}, error);
                next(
                    new OndcProtocolError(
                        '31001',
                        'Error proceeding with flow',
                        (error as Error)?.message ?? 'Unknown error'
                    )
                );
            }
        },
        getFlowStatusController: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {
            try {
                const query = req.query;
                const zodSchema = getFlowStatusQuerySchema;
                const parsedQuery = zodSchema.safeParse(query);
                if (!parsedQuery.success) {
                    next(
                        new httpValidationError('Invalid query parameters', [
                            parsedQuery.error.message,
                        ])
                    );
                    return;
                }
                const { transaction_id, session_id } = parsedQuery.data;
                const sessionData = await workbenchCache
                    .NpSessionalCacheService()
                    .getSessionData(session_id);
                const subscriberURL = sessionData?.subscriberUrl;
                const transactionData = await workbenchCache
                    .TransactionalCacheService()
                    .getTransactionData(transaction_id, subscriberURL);
                const mockSessionData = await workbenchCache
                    .TxnBusinessCacheService()
                    .getMockSessionData(transaction_id, subscriberURL);
                const flowWorkingState = await workbenchCache
                    .FlowStatusCacheService()
                    .getFlowStatus(
                        transaction_id,
                        subscriberURL,
                        getLoggerData(req)
                    );
                const flow = fetchFlow(sessionData, transactionData.flowId);
                const flowStatus = getFlowCompleteStatus(
                    transactionData,
                    flow,
                    flowWorkingState.status,
                    mockSessionData
                );
                sendSuccess(res, flowStatus);
                return;
            } catch (error) {
                logger.error(
                    'Error in getFlowStatusController',
                    req.query,
                    error
                );
                return next(
                    new OndcProtocolError(
                        '31001',
                        'Error fetching flow status',
                        (error as Error)?.message ?? 'Unknown error'
                    )
                );
            }
        },
        actUponFlow: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {},
    };
};
