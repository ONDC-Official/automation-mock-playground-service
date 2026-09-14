import { SessionCache } from '../types/cache-types';
import { Flow } from '../types/flow-types';
import { MockSessionCache } from '../types/mock-service-types';
import { BecknContext } from '../types/ondc-types';

/** Form step types, matched case-insensitively: the mock-runner's conversion emits
 *  uppercase types for its known apis (HTML_FORM, DYNAMIC_FORM) but passes unknown
 *  apis (html_form_multi) through lowercase. */
const FORM_STEP_TYPES = new Set([
    'HTML_FORM',
    'DYNAMIC_FORM',
    'HTML_FORM_MULTI',
]);
export function isFormStepType(type?: string | null): boolean {
    return !!type && FORM_STEP_TYPES.has(type.toUpperCase());
}
export function isHtmlFormStepType(type?: string | null): boolean {
    return (
        !!type &&
        (type.toUpperCase() === 'HTML_FORM' ||
            type.toUpperCase() === 'HTML_FORM_MULTI')
    );
}

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
    if (action == 'search') {
        return context.bap_uri;
    }
    if (action.startsWith('on')) {
        if (!context.bpp_uri) {
            throw new Error(
                '[MOCK_SERVICE] BPP URI is not present in the context'
            );
        }
        return context.bpp_uri;
    }
    return context.bap_uri;
}

export function getReferenceData(
    sessionData: MockSessionCache,
    flow: Flow
): Record<string, unknown> {
    const referenceData: Record<string, unknown> = {};
    const formSteps = flow.sequence.filter(step => isFormStepType(step.type));
    formSteps.forEach(step => {
        const stepKey = step.key;
        if (Array.isArray(sessionData[stepKey])) {
            referenceData[stepKey] = sessionData[stepKey][0];
        } else {
            referenceData[stepKey] = sessionData[stepKey];
        }
    });
    return referenceData;
}
