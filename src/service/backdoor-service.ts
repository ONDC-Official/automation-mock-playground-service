import { ClearFlowsQuery, ClearFlowsResult } from '../types/backdoor-types';
import logger from '../utils/logger';
import { MockRunnerConfigCache } from './cache/config-cache';

export class BackdoorService {
    constructor(private cacheService: MockRunnerConfigCache) {}

    /**
     * Clear cached flow configurations based on provided filters
     *
     * @param query - Filter parameters (domain, version, flowId)
     * @returns Result with deletion count and pattern used
     */
    async clearFlowCache(query: ClearFlowsQuery): Promise<ClearFlowsResult> {
        const { domain, version, flowId } = query;

        // Build the cache key pattern based on provided parameters
        // Key format: domain::version::flowId
        let pattern: string;
        let description: string;

        if (flowId && version) {
            // Clear specific flow
            pattern = `${domain.trim()}::${version.trim()}::${flowId.trim()}`;
            description = `Specific flow: ${domain}::${version}::${flowId}`;
        } else if (version) {
            // Clear all flows for domain and version
            pattern = `${domain.trim()}::${version.trim()}::*`;
            description = `All flows for ${domain}::${version}`;
        } else {
            // Clear all flows for domain
            pattern = `${domain.trim()}::*`;
            description = `All flows for domain ${domain}`;
        }

        // Delete keys matching the pattern
        const deletedCount = await this.cacheService.deletePattern(pattern);

        logger.info('Flow cache cleared', {
            pattern,
            deletedCount,
            domain,
            version,
            flowId,
        });

        return {
            message: 'Successfully cleared flow cache',
            description,
            deletedCount,
            pattern,
        };
    }
}
