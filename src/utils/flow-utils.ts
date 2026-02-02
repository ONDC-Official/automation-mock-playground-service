import { SessionCache } from '../types/cache-types';
import { Flow } from '../types/flow-types';
import { BecknContext } from '../types/ondc-types';

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

export function computeSubscriber(context: BecknContext) {
    const action = context.action;
    if (action.startsWith('on')) {
        if (!context.bpp_uri) {
            throw new Error('BPP URI is not present in the context');
        }
        return context.bpp_uri;
    }
    return context.bap_uri;
}
