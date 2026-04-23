import MockRunner from '@ondc/automation-mock-runner';
import { ICacheService } from '../../cache/cache-interface';
import {
    MockRunnerConfig,
    MockRunnerConfigSchema,
} from '../../types/mock-runner-types';
import { fetchMockRunnerConfigFromService } from '../../utils/runner-utils';
import logger from '@ondc/automation-logger';
const resolveApiServiceUrls = () => {
    let url =
        process.env.API_SERVICE_URL ||
        'https://dev-automation.ondc.org/api-service';
    if (url.endsWith('/')) url = url.slice(0, -1);
    const afterScheme = url.split('//')[1];
    if (!afterScheme) {
        logger.error('resolveApiServiceUrls: malformed API_SERVICE_URL', {
            url,
            envValue: process.env.API_SERVICE_URL,
        });
        throw new Error(`Malformed API_SERVICE_URL: ${url}`);
    }
    const ownerId = afterScheme.split('/')[0];
    logger.debug('resolveApiServiceUrls resolved', { url, ownerId });
    return { url, ownerId };
};

export const newMockRunnerConfigCache = (
    cache1: ICacheService, // config cache
    cache0: ICacheService // workbench cache
) => {
    const mockRunnerInstances: Map<string, MockRunner> = new Map();
    const mockRunnerTimers: Map<string, NodeJS.Timeout> = new Map();
    const mockRunnerInFlight: Map<string, Promise<MockRunner>> = new Map();
    const RUNNER_TTL_MS = 5 * 60 * 1000; // 5 minutes

    const setRunnerWithTTL = (key: string, runner: MockRunner): void => {
        const existing = mockRunnerTimers.get(key);
        if (existing) {
            clearTimeout(existing);
            logger.debug('setRunnerWithTTL: cleared existing TTL timer', {
                key,
            });
        }
        mockRunnerInstances.set(key, runner);
        const timer = setTimeout(() => {
            logger.info('mockRunner TTL expired, evicting from memory', {
                key,
                ttlMs: RUNNER_TTL_MS,
            });
            mockRunnerInstances.delete(key);
            mockRunnerTimers.delete(key);
        }, RUNNER_TTL_MS);
        timer.unref();
        mockRunnerTimers.set(key, timer);
        logger.debug('setRunnerWithTTL: runner cached', {
            key,
            totalCachedRunners: mockRunnerInstances.size,
        });
    };

    const createKey = (
        domain: string,
        version?: string,
        flowId?: string,
        usecaseId?: string
    ) => {
        return `${domain.trim()}::${version?.trim() ?? ''}::${flowId?.trim() ?? ''}::${usecaseId?.trim() ?? ''}`;
    };

    const getMockRunnerConfig = async (
        domain: string,
        version: string,
        flowId: string,
        usecaseId: string,
        sessionId?: string
    ): Promise<MockRunnerConfig> => {
        const start = Date.now();
        logger.info('getMockRunnerConfig: start', {
            domain,
            version,
            flowId,
            usecaseId,
            sessionId,
        });
        let config: MockRunnerConfig | null = null;
        if (usecaseId === 'PLAYGROUND-FLOW') {
            if (!sessionId) {
                logger.error(
                    'getMockRunnerConfig: PLAYGROUND-FLOW missing sessionId',
                    { domain, version, flowId, usecaseId }
                );
                throw new Error(
                    'sessionId required for PLAYGROUND-FLOW usecase'
                );
            }
            const runtimeKey = 'PLAYGROUND_' + sessionId;
            logger.debug('getMockRunnerConfig: reading playground cache', {
                runtimeKey,
            });
            let val: MockRunnerConfig | null = null;
            try {
                val = await cache0.get(runtimeKey, MockRunnerConfigSchema);
            } catch (err) {
                logger.error(
                    'getMockRunnerConfig: cache0.get threw for playground key',
                    {
                        runtimeKey,
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                    }
                );
                throw err;
            }
            if (val == null) {
                logger.error(
                    'getMockRunnerConfig: no config in runtime cache for playground session',
                    { runtimeKey, sessionId }
                );
                throw new Error(
                    `No config found in runtime cache for session ${sessionId}`
                );
            }
            logger.debug('getMockRunnerConfig: playground cache hit', {
                runtimeKey,
            });
            config = val;
        } else {
            const key = createKey(domain, version, flowId, usecaseId);
            logger.debug('getMockRunnerConfig: reading config cache', { key });
            try {
                config = await cache1.get(key, MockRunnerConfigSchema);
            } catch (err) {
                logger.error('getMockRunnerConfig: cache1.get threw', {
                    key,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined,
                });
                throw err;
            }
            if (config == null) {
                logger.info(
                    'getMockRunnerConfig: cache miss, fetching from config service',
                    { key, domain, version, flowId, usecaseId }
                );
                try {
                    config = await fetchMockRunnerConfigFromService(
                        domain,
                        version,
                        flowId,
                        usecaseId
                    );
                } catch (err) {
                    logger.error(
                        'getMockRunnerConfig: fetchMockRunnerConfigFromService failed',
                        {
                            key,
                            domain,
                            version,
                            flowId,
                            usecaseId,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                        }
                    );
                    throw err;
                }
                try {
                    await cache1.set(key, config, MockRunnerConfigSchema);
                    logger.debug('getMockRunnerConfig: cached fetched config', {
                        key,
                    });
                } catch (err) {
                    logger.error(
                        'getMockRunnerConfig: cache1.set failed, continuing with in-memory config',
                        {
                            key,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        }
                    );
                }
            } else {
                logger.debug('getMockRunnerConfig: config cache hit', { key });
            }
        }

        if (!config.transaction_data || !config.meta) {
            logger.error(
                'getMockRunnerConfig: config missing transaction_data or meta',
                {
                    hasTransactionData: !!config.transaction_data,
                    hasMeta: !!config.meta,
                    domain,
                    version,
                    flowId,
                    usecaseId,
                }
            );
            throw new Error('Invalid config: missing transaction_data or meta');
        }

        const { url: apiServiceUrl, ownerId } = resolveApiServiceUrls();
        config.transaction_data.bap_id = config.transaction_data.bpp_id =
            ownerId;
        config.transaction_data.bap_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/buyer`;
        config.transaction_data.bpp_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/seller`;
        logger.info('getMockRunnerConfig: done', {
            domain,
            version,
            flowId,
            usecaseId,
            sessionId,
            ownerId,
            bapUri: config.transaction_data.bap_uri,
            bppUri: config.transaction_data.bpp_uri,
            durationMs: Date.now() - start,
        });
        return config;
    };

    const getRunnerInstance = async (
        domain: string,
        version: string,
        flowId: string,
        usecaseId: string,
        sessionId?: string
    ): Promise<MockRunner> => {
        logger.info('fetching mock runner instance', {
            domain,
            version,
            flowId,
            usecaseId,
            sessionId,
        });
        if (usecaseId === 'PLAYGROUND-FLOW') {
            if (!sessionId) {
                logger.error(
                    'getRunnerInstance: PLAYGROUND-FLOW missing sessionId',
                    { domain, version, flowId, usecaseId }
                );
                throw new Error(
                    'sessionId required for PLAYGROUND-FLOW usecase'
                );
            }
            const runtimeKey = 'PLAYGROUND_' + sessionId;

            if (mockRunnerInstances.has(runtimeKey)) {
                logger.debug('getRunnerInstance: in-memory hit (playground)', {
                    runtimeKey,
                });
                return mockRunnerInstances.get(runtimeKey) as MockRunner;
            }
            if (mockRunnerInFlight.has(runtimeKey)) {
                logger.debug(
                    'getRunnerInstance: reusing in-flight promise (playground)',
                    { runtimeKey }
                );
                return mockRunnerInFlight.get(
                    runtimeKey
                ) as Promise<MockRunner>;
            }

            logger.info(
                'getRunnerInstance: constructing new MockRunner (playground)',
                { runtimeKey }
            );
            const promise = (async () => {
                const val = await getMockRunnerConfig(
                    domain,
                    version,
                    flowId,
                    usecaseId,
                    sessionId
                );
                const mockRunner = new MockRunner(val);
                setRunnerWithTTL(runtimeKey, mockRunner);
                return mockRunner;
            })();

            promise
                .catch(err => {
                    logger.error(
                        'getRunnerInstance: in-flight promise rejected (playground)',
                        {
                            runtimeKey,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                        }
                    );
                })
                .finally(() => {
                    mockRunnerInFlight.delete(runtimeKey);
                });

            mockRunnerInFlight.set(runtimeKey, promise);
            return promise;
        } else {
            const key = createKey(domain, version, flowId, usecaseId);

            if (mockRunnerInstances.has(key)) {
                logger.debug('getRunnerInstance: in-memory hit', { key });
                return mockRunnerInstances.get(key) as MockRunner;
            }
            if (mockRunnerInFlight.has(key)) {
                logger.debug('getRunnerInstance: reusing in-flight promise', {
                    key,
                });
                return mockRunnerInFlight.get(key) as Promise<MockRunner>;
            }

            logger.info('getRunnerInstance: constructing new MockRunner', {
                key,
            });
            const promise = (async () => {
                const config = await getMockRunnerConfig(
                    domain,
                    version,
                    flowId,
                    usecaseId
                );
                const mockRunner = new MockRunner(config);
                setRunnerWithTTL(key, mockRunner);
                return mockRunner;
            })();

            promise
                .catch(err => {
                    logger.error(
                        'getRunnerInstance: in-flight promise rejected',
                        {
                            key,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                        }
                    );
                })
                .finally(() => {
                    mockRunnerInFlight.delete(key);
                });

            mockRunnerInFlight.set(key, promise);
            return promise;
        }
    };

    return {
        getMockRunnerConfig: getMockRunnerConfig,
        createKey: createKey,
        deletePattern: async (pattern: string): Promise<number> => {
            logger.info('deletePattern: invoked', {
                pattern,
                instancesBefore: mockRunnerInstances.size,
                inFlightBefore: mockRunnerInFlight.size,
            });
            const regex = new RegExp(
                '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            );
            let evicted = 0;
            for (const key of mockRunnerInstances.keys()) {
                if (regex.test(key)) {
                    mockRunnerInstances.delete(key);
                    const timer = mockRunnerTimers.get(key);
                    if (timer) {
                        clearTimeout(timer);
                        mockRunnerTimers.delete(key);
                    }
                    mockRunnerInFlight.delete(key);
                    evicted++;
                }
            }
            let cacheDeleted = 0;
            try {
                cacheDeleted = await cache1.deletePattern(pattern);
            } catch (err) {
                logger.error('deletePattern: cache1.deletePattern failed', {
                    pattern,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined,
                });
                throw err;
            }
            logger.info('deletePattern: done', {
                pattern,
                evictedFromMemory: evicted,
                deletedFromCache: cacheDeleted,
            });
            return cacheDeleted;
        },
        getRunnerInstance: getRunnerInstance,
    };
};

export type MockRunnerConfigCache = ReturnType<typeof newMockRunnerConfigCache>;
