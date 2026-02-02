import { NextFunction, Response } from 'express';
import { randomUUID } from 'crypto';

import { ApiRequest } from '../routes/manualRoutes';
import { IQueueService } from '../queue/IQueueService';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';

import {
    getFlowStatusQuerySchema,
    proceedWithFlowBodySchema,
    startNewFlowBodySchema,
} from '../types/request-types';

import {
    InternalServerError,
    normalizeError,
    OndcProtocolError,
} from '../errors/custom-errors';

import { sendSuccess } from '../utils/res-utils';
import { computeSubscriber, fetchFlow } from '../utils/flow-utils';
import { getFlowCompleteStatus } from '../service/flows/flow-mapper';
import { ActOnFlowService as processFlow } from '../service/flows/process-flow';

import { validateOrThrow } from '../utils/validation';
import {
    assertFlowContext,
    attachFlowContext,
} from '../types/process-flow-types';
import { getLoggerMeta, logError } from '../utils/req-utils';

export const flowControllers = (
    queueService: IQueueService,
    workbenchCache: WorkbenchCacheServiceType
) => ({
    receivePayloadFromApiService: async (
        req: ApiRequest,
        res: Response,
        next: NextFunction
    ) => {
        try {
            const context = req.body.context;
            const transactionId = context.transaction_id;
            const subscriberUrl = computeSubscriber(context);
            const transactionData = await workbenchCache
                .TransactionalCacheService()
                .getTransactionData(transactionId, subscriberUrl);
            const flowId = transactionData.flowId;
            if (!transactionData.sessionId) {
                throw new InternalServerError(
                    'Session ID not found in transaction data'
                );
            }
            const sessionData = await workbenchCache
                .NpSessionalCacheService()
                .getSessionData(transactionData.sessionId);
            const flow = fetchFlow(sessionData, flowId);
            attachFlowContext(req, {
                flow,
                flowId,
                transactionId,
                subscriberUrl,
                apiSessionCache: sessionData,
                transactionData,
                domain: sessionData.domain,
                version: sessionData.version,
            });
            next();
        } catch (error) {
            logError(req, 'receivePayloadFromApiService failed', error);
            next(
                normalizeError(
                    error,
                    new OndcProtocolError(
                        '31001',
                        'Error receiving payload from API service',
                        'Unknown error'
                    )
                )
            );
        }
    },

    startNewFlowController: async (
        req: ApiRequest,
        res: Response,
        next: NextFunction
    ) => {
        try {
            const body = validateOrThrow(
                startNewFlowBodySchema,
                req.body,
                'Invalid request body'
            );

            const transactionId = body.transaction_id ?? randomUUID();

            const sessionData = await workbenchCache
                .NpSessionalCacheService()
                .getSessionData(body.session_id);

            if (!sessionData) {
                throw new InternalServerError(
                    'Session not found: ' + body.session_id
                );
            }

            const flow = fetchFlow(sessionData, body.flow_id);

            attachFlowContext(req, {
                flow,
                flowId: body.flow_id,
                transactionId,
                subscriberUrl: sessionData.subscriberUrl,
                apiSessionCache: sessionData,
                domain: sessionData.domain,
                version: sessionData.version,
                inputs: body.inputs,
                transactionData: {
                    latestAction: '',
                    latestTimestamp: '',
                    type: 'manual',
                    subscriberType: sessionData.npType,
                    flowId: body.flow_id,
                    sessionId: body.session_id,
                    messageIds: [],
                    apiList: [],
                },
            });

            next();
        } catch (error) {
            logError(req, 'startNewFlowController failed', error);
            next(
                normalizeError(
                    error,
                    new OndcProtocolError(
                        '31001',
                        'Error starting new flow',
                        'Unknown error'
                    )
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
            const body = validateOrThrow(
                proceedWithFlowBodySchema,
                req.body,
                'Invalid request body'
            );

            const sessionData = await workbenchCache
                .NpSessionalCacheService()
                .getSessionData(body.session_id);

            if (!sessionData) {
                throw new InternalServerError(
                    'Session not found: ' + body.session_id
                );
            }

            const transactionData = await workbenchCache
                .TransactionalCacheService()
                .getTransactionData(
                    body.transaction_id,
                    sessionData.subscriberUrl
                );

            if (!transactionData) {
                throw new InternalServerError(
                    'Transaction not found: ' + body.transaction_id
                );
            }

            const flow = fetchFlow(sessionData, transactionData.flowId);

            attachFlowContext(req, {
                flow,
                flowId: transactionData.flowId,
                transactionId: body.transaction_id,
                subscriberUrl: sessionData.subscriberUrl,
                apiSessionCache: sessionData,
                transactionData,
                domain: sessionData.domain,
                version: sessionData.version,
                inputs: body.inputs,
            });

            next();
        } catch (error) {
            logError(req, 'proceedWithFlowController failed', error);
            next(
                normalizeError(
                    error,
                    new OndcProtocolError(
                        '31001',
                        'Error proceeding with flow',
                        'Unknown error'
                    )
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
            const query = validateOrThrow(
                getFlowStatusQuerySchema,
                req.query,
                'Invalid query parameters'
            );

            const sessionData = await workbenchCache
                .NpSessionalCacheService()
                .getSessionData(query.session_id);

            if (!sessionData) {
                throw new InternalServerError(
                    'Session not found: ' + query.session_id
                );
            }

            const subscriberUrl = sessionData.subscriberUrl;

            const transactionData = await workbenchCache
                .TransactionalCacheService()
                .getTransactionData(query.transaction_id, subscriberUrl);

            const mockSessionData = await workbenchCache
                .TxnBusinessCacheService()
                .getMockSessionData(query.transaction_id, subscriberUrl);

            const flowWorkingState = await workbenchCache
                .FlowStatusCacheService()
                .getFlowStatus(
                    query.transaction_id,
                    subscriberUrl,
                    getLoggerMeta(req)
                );

            const flow = fetchFlow(sessionData, transactionData.flowId);

            const status = getFlowCompleteStatus(
                transactionData,
                flow,
                flowWorkingState.status,
                mockSessionData
            );

            sendSuccess(res, status);
        } catch (error) {
            logError(req, 'getFlowStatusController failed', error);
            next(
                normalizeError(
                    error,
                    new OndcProtocolError(
                        '31001',
                        'Error fetching flow status',
                        'Unknown error'
                    )
                )
            );
        }
    },

    actUponFlow: async (req: ApiRequest, res: Response, next: NextFunction) => {
        try {
            assertFlowContext(req);
            const result = await processFlow(
                req.flowContext,
                workbenchCache,
                queueService
            );
            sendSuccess(res, result, true);
            return;
        } catch (error) {
            logError(req, 'actUponFlow failed', error);
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
});
