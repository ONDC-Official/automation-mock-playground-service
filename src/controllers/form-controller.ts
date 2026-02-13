import { NextFunction, Request, Response } from 'express';
import { logError } from '../utils/req-utils';
import {
    getFormQuerySchema,
    submitFormQuerySchema,
} from '../types/request-types';
import { validateOrThrow } from '../utils/validation';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import { MockRunnerConfigCache } from '../service/cache/config-cache';
import { getConfigStep } from '../utils/runner-utils';
import {
    handleFormSubmitService,
    handleGetFormService,
} from '../service/forms/form-handlers';
import { sendSuccess } from '../utils/res-utils';
import logger from '@ondc/automation-logger';
import { IQueueService } from '../queue/IQueueService';

export const newFormControllers = (
    workbenchCache: WorkbenchCacheServiceType,
    mockRunnerCache: MockRunnerConfigCache,
    queueService: IQueueService
) => {
    return {
        getFormController: async (
            req: Request,
            res: Response,
            next: NextFunction
        ) => {
            try {
                logger.info('Received request for getFormController');
                const { domain, formId } = req.params;
                if (Array.isArray(domain) || Array.isArray(formId)) {
                    throw new Error('Invalid parameters');
                }
                const data = validateOrThrow(
                    getFormQuerySchema,
                    req.query,
                    'Invalid query parameters for getFormController'
                );
                const sessionData = await workbenchCache
                    .NpSessionalCacheService()
                    .getSessionData(data.session_id);
                const transactionData = await workbenchCache
                    .TransactionalCacheService()
                    .getTransactionData(
                        data.transaction_id,
                        sessionData.subscriberUrl
                    );
                const runnerConfig = await mockRunnerCache.getMockRunnerConfig(
                    domain,
                    sessionData.version,
                    transactionData.flowId,
                    sessionData.usecaseId,
                    data.session_id
                );
                const stepConfig = getConfigStep(runnerConfig, formId);
                const formResponse = await handleGetFormService(
                    stepConfig,
                    transactionData,
                    data,
                    formId,
                    domain
                );
                if (formResponse.dataType === 'json') {
                    sendSuccess(res, formResponse.data);
                    return;
                }
                if (formResponse.dataType === 'html') {
                    res.type('html').send(formResponse.data);
                    return;
                }
                throw new Error('Invalid response type from form handler');
            } catch (error) {
                logError(req, 'Error in getFormController', error);
                next(error);
            }
        },
        submitFormController: async (
            req: Request,
            res: Response,
            next: NextFunction
        ) => {
            try {
                const { domain, formId } = req.params;
                const formData = req.body;
                logger.info('Received request for submitFormController', {
                    formData: formData,
                });
                if (Array.isArray(domain) || Array.isArray(formId)) {
                    throw new Error('Invalid parameters');
                }
                const data = validateOrThrow(
                    submitFormQuerySchema,
                    req.query,
                    'Invalid query parameters for submitFormController'
                );
                const sessionData = await workbenchCache
                    .NpSessionalCacheService()
                    .getSessionData(data.session_id);
                const transactionData = await workbenchCache
                    .TransactionalCacheService()
                    .getTransactionData(
                        data.transaction_id,
                        sessionData.subscriberUrl
                    );
                const runnerConfig = await mockRunnerCache.getMockRunnerConfig(
                    domain,
                    sessionData.version,
                    transactionData.flowId,
                    sessionData.usecaseId,
                    data.session_id
                );
                const stepConfig = getConfigStep(runnerConfig, formId);
                const submitResponse = await handleFormSubmitService(
                    stepConfig,
                    formData,
                    workbenchCache,
                    data,
                    formId,
                    sessionData,
                    transactionData,
                    queueService
                );
                if (submitResponse.dataType === 'json') {
                    sendSuccess(res, submitResponse.data);
                    return;
                }
                if (submitResponse.dataType === 'html') {
                    res.type('html').send(submitResponse.data);
                    return;
                }
                throw new Error(
                    'Invalid response type from form submit handler'
                );
            } catch (error) {
                logError(req, 'Error in submitFormController', error);
                next(error);
            }
        },
    };
};
