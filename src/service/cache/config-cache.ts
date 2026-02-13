import { ICacheService } from '../../cache/cache-interface';
import {
    MockRunnerConfig,
    MockRunnerConfigSchema,
} from '../../types/mock-runner-types';
import { fetchMockRunnerConfigFromService } from '../../utils/runner-utils';

export const newMockRunnerConfigCache = (
    cache1: ICacheService,
    cache0: ICacheService
) => {
    const createKey = (
        domain: string,
        version?: string,
        flowId?: string,
        usecaseId?: string
    ) => {
        return `${domain.trim()}::${version?.trim() ?? ''}::${flowId?.trim() ?? ''}::${usecaseId?.trim() ?? ''}`;
    };

    return {
        getMockRunnerConfig: async (
            domain: string,
            version: string,
            flowId: string,
            usecaseId: string,
            sessionId?: string
        ): Promise<MockRunnerConfig> => {
            let config: MockRunnerConfig | null = null;
            if (usecaseId === 'PLAYGROUND-FLOW') {
                const runtimeKey = 'PLAYGROUND_' + sessionId;
                const val = await cache0.get(
                    runtimeKey,
                    MockRunnerConfigSchema
                );
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

            let apiServiceUrl =
                process.env.API_SERVICE_URL ||
                'https://dev-automation.ondc.org/api-service';
            if (apiServiceUrl.endsWith('/')) {
                apiServiceUrl = apiServiceUrl.slice(0, -1);
            }
            const ownerId = apiServiceUrl.split('//')[1].split('/')[0];
            config.transaction_data.bap_id = config.transaction_data.bpp_id =
                ownerId;
            config.transaction_data.bap_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/buyer`;
            config.transaction_data.bpp_uri = `${apiServiceUrl}/${config.meta.domain}/${config.meta.version}/seller`;
            return config;
        },
        createKey: createKey,
        deletePattern: async (pattern: string): Promise<number> => {
            return cache1.deletePattern(pattern);
        },
    };
};

export type MockRunnerConfigCache = ReturnType<typeof newMockRunnerConfigCache>;
