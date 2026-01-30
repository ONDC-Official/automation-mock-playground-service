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
            return config;
        },
        createKey: createKey,
    };
};

export type MockRunnerConfigCache = ReturnType<typeof newMockRunnerConfigCache>;
