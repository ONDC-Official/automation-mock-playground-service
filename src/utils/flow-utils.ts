import { SessionCache } from '../types/cache-types';
import { Flow } from '../types/flow-types';

export function fetchFlow(sessionData: SessionCache, flowId: string): Flow {
    if (!sessionData || !sessionData.flowConfigs) {
        throw new Error(
            'Session data or flow configurations are not available'
        );
    }
    if (!sessionData.flowConfigs[flowId]) {
        throw new Error(
            `Flow not found for flowId: ${flowId} in the session data`
        );
    }
    const flow = sessionData.flowConfigs[flowId];
    return flow;
}
