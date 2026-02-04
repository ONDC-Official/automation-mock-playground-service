import MockRunner from '@ondc/automation-mock-runner';
import jsonpath from 'jsonpath';
import { ICacheService } from '../../cache/cache-interface';
import {
    SessionCacheSchema,
    SubscriberCache,
    SubscriberCacheSchema,
    TransactionCacheSchema,
} from '../../types/cache-types';
import {
    MockFlowStatusCache,
    MockFlowStatusCacheSchema,
    MockSessionCache,
    MockSessionCacheSchema,
    MockStatusCode,
    SaveDataConfig,
} from '../../types/mock-service-types';
import logger from '../../utils/logger';

const createTransactionalCache = (cache: ICacheService) => {
    const generateTransactionKey = (
        transactionID: string,
        subscriberURL: string
    ): string => {
        return `${transactionID.trim()}::${subscriberURL.trim()}`;
    };

    const getTransactionData = async (
        transactionID: string,
        subscriberURL: string
    ) => {
        const key = generateTransactionKey(transactionID, subscriberURL);
        const value = await cache.get(key, TransactionCacheSchema);
        if (value == null) {
            throw new Error(
                `No transaction data found for transaction ID: ${transactionID} and subscriber URL: ${subscriberURL}`
            );
        }
        return value;
    };

    return {
        getTransactionData,
    };
};

const createNpSessionalCache = (cache: ICacheService) => {
    const getSessionData = async (sessionID: string) => {
        const data = await cache.get(sessionID, SessionCacheSchema);
        if (!data) {
            throw new Error(
                `No session data found for session ID: ${sessionID}`
            );
        }
        return data;
    };

    return {
        getSessionData,
    };
};

const createTxnBusinessCache = (cache: ICacheService) => {
    const getMockSessionData = async (
        transactionID: string,
        subscriberURL?: string
    ) => {
        if ((await cache.exists(transactionID)) === false) {
            const data = {
                transaction_id: transactionID,
                subscriber_url: subscriberURL || null,
            };
            return data as MockSessionCache;
        }
        const data = await cache.get(transactionID, MockSessionCacheSchema);
        if (!data) {
            throw new Error(
                `No mock session data found for transaction ID: ${transactionID}`
            );
        }
        return data;
    };

    const getUpdatedData = async (
        saveDataConfig: SaveDataConfig['save-data'],
        payload: unknown,
        existingData: unknown
    ) => {
        const data = existingData as Record<string, unknown>;

        for (const key in saveDataConfig) {
            try {
                const path = saveDataConfig[key as keyof typeof saveDataConfig];
                const appendMode = key.startsWith('APPEND#');
                const evalMode = path.startsWith('EVAL#');
                const actualKey = key.split('#').pop() as string;
                const actualPath = evalMode ? path.split('#')[1] : path;
                const result = evalMode
                    ? (await MockRunner.runGetSave(payload, actualPath)).result
                    : jsonpath.query(payload, actualPath);
                if (appendMode) {
                    const currentData = (data[actualKey] as unknown[]) || [];
                    data[actualKey] = [...currentData, ...result];
                } else {
                    data[actualKey] = result;
                }
            } catch (error) {
                logger.error(
                    `Error in saving data for key: ${key}`,
                    { saveDataConfig, payload, existingData },
                    error
                );
            }
        }
        return data;
    };

    const saveMockSessionData = async (
        transactionID: string,
        ondcPayload: unknown,
        saveDataConfig: SaveDataConfig
    ) => {
        const currentData = await getMockSessionData(transactionID);
        const updatedData = await getUpdatedData(
            saveDataConfig['save-data'],
            ondcPayload,
            currentData
        );
        return cache.set(transactionID, updatedData, MockSessionCacheSchema);
    };

    const overwriteMockSessionData = async (
        transactionID: string,
        data: unknown
    ) => {
        return cache.set(transactionID, data, MockSessionCacheSchema);
    };

    return {
        getMockSessionData,
        saveMockSessionData,
        overwriteMockSessionData,
    };
};

const flowStatusCache = (cache: ICacheService) => {
    const createFlowStatusCacheKey = (
        transactionId: string,
        subscriberUrl: string
    ): string => {
        return `FLOW_STATUS_${transactionId}::${subscriberUrl}`;
    };

    const getFlowStatus = async (
        transactionId: string,
        subscriberUrl: string,
        loggingMeta: unknown
    ): Promise<MockFlowStatusCache> => {
        try {
            logger.info(
                `Getting flow operation status for transactionId: ${transactionId} and subscriberUrl: ${subscriberUrl}`,
                loggingMeta
            );
            const key = createFlowStatusCacheKey(transactionId, subscriberUrl);
            const cached = await cache.get(key, MockFlowStatusCacheSchema);
            if (cached) {
                return cached;
            }
            logger.info("Returning 'AVAILABLE' status", loggingMeta);
            return { status: 'AVAILABLE' };
        } catch (error) {
            logger.error(
                'Error in getting flow status [fallback = AVAILABLE]',
                loggingMeta,
                error
            );
            return { status: 'AVAILABLE' };
        }
    };

    const setFlowStatus = async (
        transactionId: string,
        subscriberUrl: string,
        flowStatus: MockStatusCode
    ): Promise<void> => {
        try {
            const key = createFlowStatusCacheKey(transactionId, subscriberUrl);

            await cache.set(
                key,
                { status: flowStatus },
                MockFlowStatusCacheSchema,
                60 * 60 * 5
            );
        } catch (error) {
            logger.error('Error in setting flow status', error);
        }
    };

    const deleteFlowStatus = async (
        transactionId?: string,
        subscriberUrl?: string
    ): Promise<void> => {
        if (!transactionId || !subscriberUrl) return;

        try {
            const key = createFlowStatusCacheKey(transactionId, subscriberUrl);

            await cache.delete(key);
        } catch (error) {
            logger.error('Error in deleting flow status', error);
        }
    };

    return {
        getFlowStatus,
        setFlowStatus,
        deleteFlowStatus,
    };
};

const subscriberCache = (cache: ICacheService) => {
    const EXPECTATION_EXPIRY = 5 * 60 * 1000; // 5 minutes

    const createExpectation = async (
        subscriberUrl: string,
        flowId: string,
        sessionId: string,
        expectedAction: string,
        loggerMeta?: unknown
    ): Promise<string> => {
        try {
            // Fetch existing session data from cache
            const existingData = await cache.get(
                subscriberUrl,
                SubscriberCacheSchema
            );

            let parsed: SubscriberCache = { activeSessions: [] };

            if (existingData) {
                parsed = existingData;
            }

            // Remove expired expectations and check for conflicts
            parsed.activeSessions = parsed.activeSessions.filter(
                expectation => {
                    const isExpired =
                        new Date(expectation.expireAt) < new Date();

                    if (isExpired) return false; // Remove expired session

                    if (expectation.sessionId === sessionId) {
                        throw new Error(
                            `Expectation already exists for sessionId: ${sessionId} and flowId: ${flowId}`
                        );
                    }

                    if (expectation.expectedAction === expectedAction) {
                        throw new Error(
                            `Expectation already exists for the action: ${expectedAction}`
                        );
                    }

                    return true; // Keep valid expectations
                }
            );

            // Add new expectation
            const expireAt = new Date(
                Date.now() + EXPECTATION_EXPIRY
            ).toISOString();

            const expectation = {
                sessionId,
                flowId,
                expectedAction,
                expireAt,
            };

            parsed.activeSessions.push(expectation);

            // Update cache with the modified session data
            await cache.set(subscriberUrl, parsed, SubscriberCacheSchema);

            logger.info(
                `Expectation created for sessionId: ${sessionId}, flowId: ${flowId}, action: ${expectedAction}`,
                loggerMeta
            );

            return 'Expectation created successfully';
        } catch (error: unknown) {
            logger.error(
                'Error in creating new action expectation',
                loggerMeta,
                error
            );
            throw new Error(
                `Failed to create expectation: ${(error as Error).message}`
            );
        }
    };

    const deleteExpectation = async (
        sessionId: string,
        subscriberUrl: string
    ): Promise<void> => {
        try {
            const subscriberData = await cache.get(
                subscriberUrl,
                SubscriberCacheSchema
            );

            if (!subscriberData) {
                throw new Error('Session not found');
            }

            logger.info(`Deleting expectation for sessionId: ${sessionId}`);

            if (subscriberData.activeSessions === undefined) {
                throw new Error('No active sessions found');
            }

            subscriberData.activeSessions =
                subscriberData.activeSessions.filter(
                    expectation => expectation.sessionId !== sessionId
                );

            await cache.set(
                subscriberUrl,
                subscriberData,
                SubscriberCacheSchema
            );
        } catch (error) {
            logger.error(
                'Error in deleting expectation',
                {
                    sessionId,
                    subscriberUrl,
                },
                error
            );
            throw new Error('Error deleting expectation');
        }
    };

    const getSubscriberData = async (
        subscriberUrl: string
    ): Promise<SubscriberCache | null> => {
        try {
            const data = await cache.get(subscriberUrl, SubscriberCacheSchema);
            return data;
        } catch (error) {
            logger.error(
                'Error in getting subscriber data',
                { subscriberUrl },
                error
            );
            return null;
        }
    };

    return {
        createExpectation,
        deleteExpectation,
        getSubscriberData,
    };
};

export type FlowStatusCacheService = ReturnType<typeof flowStatusCache>;
export type SubscriberCacheService = ReturnType<typeof subscriberCache>;

export const WorkbenchCacheService = (cache: ICacheService) => {
    const transactionalCache = createTransactionalCache(cache);
    const sessionalCache = createNpSessionalCache(cache);
    const txnBusinessCache = createTxnBusinessCache(cache);
    const flowStatusCacheService = flowStatusCache(cache);
    const subscriberCacheService = subscriberCache(cache);
    return {
        TransactionalCacheService: () => transactionalCache,
        NpSessionalCacheService: () => sessionalCache,
        TxnBusinessCacheService: () => txnBusinessCache,
        FlowStatusCacheService: () => flowStatusCacheService,
        SubscriberCacheService: () => subscriberCacheService,
    };
};

export type WorkbenchCacheServiceType = ReturnType<
    typeof WorkbenchCacheService
>;
