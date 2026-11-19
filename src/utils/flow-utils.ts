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

/**
 * The participant whose session an incoming payload belongs to.
 *
 * The api-service knows which side received the call and passes that participant's url
 * as the `subscriber_url` query param; it is used when it names one side of the context.
 * Without it (an older api-service, or a url matching neither side) the beckn convention
 * decides: on_* comes from the BPP, the rest from the BAP. That convention is wrong for a
 * request the seller sends (an RSF recon owned by the BPP) and for a callback the buyer
 * sends (its on_recon), and in a workbench-to-workbench run it files the payload under
 * the sender's own session.
 */
export function computeSubscriber(
    context: BecknContext,
    subscriberUrl?: unknown
) {
    if (typeof subscriberUrl === 'string' && subscriberUrl !== '') {
        const participant = [context.bap_uri, context.bpp_uri].find(uri =>
            sameUrl(uri, subscriberUrl)
        );
        if (participant) return participant;
    }
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

/** Compares two subscriber urls, ignoring a trailing slash. */
function sameUrl(a: string | undefined, b: string): boolean {
    return !!a && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
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
