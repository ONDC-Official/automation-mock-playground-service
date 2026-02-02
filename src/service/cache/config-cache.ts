import { ICacheService } from '../../cache/cache-interface';
import {
    MockRunnerConfig,
    MockRunnerConfigSchema,
} from '../../types/mock-runner-types';

export const newMockRunnerConfigCache = (cache: ICacheService) => {
    const createKey = (domain: string, version: string, flowId: string) => {
        return `${domain.trim()}::${version.trim()}::${flowId.trim()}`;
    };

    return {
        getMockRunnerConfig: async (
            domain: string,
            version: string,
            flowId: string
        ): Promise<MockRunnerConfig> => {
            const key = createKey(domain, version, flowId);
            const config = await cache.get(key, MockRunnerConfigSchema);
            if (config == null) {
                // TODO fetch from config service
                throw new Error(`config service not implemented`);
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
    };
};

export type MockRunnerConfigCache = ReturnType<typeof newMockRunnerConfigCache>;
