import MockRunner from '@ondc/automation-mock-runner';
import { ICacheService } from '../../cache/cache-interface';
import {
    MockRunnerConfig,
    MockRunnerConfigSchema,
} from '../../types/mock-runner-types';
import { fetchMockRunnerConfigFromService } from '../../utils/runner-utils';

const resolveApiServiceUrls = () => {
    let url =
        process.env.API_SERVICE_URL ||
        'https://dev-automation.ondc.org/api-service';
    if (url.endsWith('/')) url = url.slice(0, -1);
    const ownerId = url.split('//')[1].split('/')[0];
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
        if (existing) clearTimeout(existing);
        mockRunnerInstances.set(key, runner);
        const timer = setTimeout(() => {
            mockRunnerInstances.delete(key);
            mockRunnerTimers.delete(key);
        }, RUNNER_TTL_MS);
        timer.unref();
        mockRunnerTimers.set(key, timer);
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
        let config: MockRunnerConfig | null = null;
        if (usecaseId === 'PLAYGROUND-FLOW') {
            const runtimeKey = 'PLAYGROUND_' + sessionId;
            const val = await cache0.get(runtimeKey, MockRunnerConfigSchema);
            if (val == null) {
                throw new Error(
                    `No config found in runtime cache for session ${sessionId}`
                );
            }
            config = val;
        } else {
            const key = createKey(domain, version, flowId, usecaseId);
            config = await cache1.get(key, MockRunnerConfigSchema);
            if (config == null) {
                config = await fetchMockRunnerConfigFromService(
                    domain,
                    version,
                    flowId,
                    usecaseId
                );
                await cache1.set(key, config, MockRunnerConfigSchema);
            }
        }

        const { url: apiServiceUrl, ownerId } = resolveApiServiceUrls();
        config.transaction_data.bap_id = config.transaction_data.bpp_id =
            ownerId;
        config.transaction_data.bap_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/buyer`;
        config.transaction_data.bpp_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/seller`;
        return config;
    };

    const getRunnerInstance = async (
        domain: string,
        version: string,
        flowId: string,
        usecaseId: string,
        sessionId?: string
    ): Promise<MockRunner> => {
        if (usecaseId === 'PLAYGROUND-FLOW') {
            const runtimeKey = 'PLAYGROUND_' + sessionId;

            if (mockRunnerInstances.has(runtimeKey)) {
                return mockRunnerInstances.get(runtimeKey) as MockRunner;
            }
            if (mockRunnerInFlight.has(runtimeKey)) {
                return mockRunnerInFlight.get(
                    runtimeKey
                ) as Promise<MockRunner>;
            }

            const promise = (async () => {
                const val = await getMockRunnerConfig(
                    domain,
                    version,
                    flowId,
                    usecaseId,
                    sessionId
                );
                if (val == null) {
                    throw new Error(
                        `No config found in runtime cache for session ${sessionId}`
                    );
                }
                const mockRunner = new MockRunner(val);
                setRunnerWithTTL(runtimeKey, mockRunner);
                mockRunnerInFlight.delete(runtimeKey);
                return mockRunner;
            })();

            mockRunnerInFlight.set(runtimeKey, promise);
            return promise;
        } else {
            const key = createKey(domain, version, flowId, usecaseId);

            if (mockRunnerInstances.has(key)) {
                return mockRunnerInstances.get(key) as MockRunner;
            }
            if (mockRunnerInFlight.has(key)) {
                return mockRunnerInFlight.get(key) as Promise<MockRunner>;
            }

            const promise = (async () => {
                const config = await getMockRunnerConfig(
                    domain,
                    version,
                    flowId,
                    usecaseId
                );
                const mockRunner = new MockRunner(config);
                setRunnerWithTTL(key, mockRunner);
                mockRunnerInFlight.delete(key);
                return mockRunner;
            })();

            mockRunnerInFlight.set(key, promise);
            return promise;
        }
    };

    return {
        getMockRunnerConfig: getMockRunnerConfig,
        createKey: createKey,
        deletePattern: async (pattern: string): Promise<number> => {
            const regex = new RegExp(
                '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            );
            for (const key of mockRunnerInstances.keys()) {
                if (regex.test(key)) {
                    mockRunnerInstances.delete(key);
                    const timer = mockRunnerTimers.get(key);
                    if (timer) {
                        clearTimeout(timer);
                        mockRunnerTimers.delete(key);
                    }
                    mockRunnerInFlight.delete(key);
                }
            }
            return cache1.deletePattern(pattern);
        },
        getRunnerInstance: getRunnerInstance,
    };
};

export type MockRunnerConfigCache = ReturnType<typeof newMockRunnerConfigCache>;
