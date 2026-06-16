import { TransactionCache } from '../../types/cache-types';
import { Flow } from '../../types/flow-types';
import { MappedStep } from '../../types/mapped-flow-types';
import {
    MockSessionCache,
    MockStatusCode,
} from '../../types/mock-service-types';
import { FlowMapBuilder } from './mapper/flow-map-builder';

const ACTIONABLE_STATUSES: ReadonlySet<MappedStep['status']> = new Set([
    'LISTENING',
    'RESPONDING',
    'INPUT-REQUIRED',
    'WAITING-SUBMISSION',
]);

export interface NextActionMeta {
    sequenceNext?: MappedStep;
    extrasNext?: MappedStep[];
}

export function getFlowCompleteStatus(
    transactionData: TransactionCache,
    flow: Flow,
    flowStatus: MockStatusCode,
    mockSessionData: MockSessionCache,
    extraFlowStatuses?: ReadonlyMap<string, MockStatusCode>
) {
    return new FlowMapBuilder(
        transactionData,
        flow,
        flowStatus,
        mockSessionData,
        extraFlowStatuses
    ).build();
}

export function getNextActions(
    transactionData: TransactionCache,
    flow: Flow,
    flowStatus: MockStatusCode,
    mockSessionData: MockSessionCache,
    extraFlowStatuses?: ReadonlyMap<string, MockStatusCode>
): NextActionMeta {
    const flowDetails = getFlowCompleteStatus(
        transactionData,
        flow,
        flowStatus,
        mockSessionData,
        extraFlowStatuses
    );
    const sequenceNext = flowDetails.sequence.find(s =>
        ACTIONABLE_STATUSES.has(s.status)
    );
    const extrasNext = (flowDetails.extraSteps ?? []).filter(s =>
        ACTIONABLE_STATUSES.has(s.status)
    );
    return { sequenceNext, extrasNext };
}

/**
 * Back-compat alias. Returns only the strict-sequence's next actionable step.
 * New code should use {@link getNextActions} to also see extras placeholders.
 */
export function getNextActionMetaData(
    transactionData: TransactionCache,
    flow: Flow,
    flowStatus: MockStatusCode,
    mockSessionData: MockSessionCache
) {
    return getNextActions(transactionData, flow, flowStatus, mockSessionData)
        .sequenceNext;
}
