import {
    FormApiType,
    HistoryType,
    TransactionCache,
} from '../../types/cache-types';
import { Flow, SequenceStep } from '../../types/flow-types';
import {
    ApiHistory,
    FlowMap,
    MappedStep,
    ReducedApiData,
    ReduceFormData,
} from '../../types/mapped-flow-types';
import {
    MockSessionCache,
    MockStatusCode,
} from '../../types/mock-service-types';
import { getReferenceData } from '../../utils/flow-utils';

export function getNextActionMetaData(
    transactionData: TransactionCache,
    flow: Flow,
    flowStatus: MockStatusCode,
    mockSessionData: MockSessionCache
) {
    const flowDetails = getFlowCompleteStatus(
        transactionData,
        flow,
        flowStatus,
        mockSessionData
    );
    const latestApi = flowDetails.sequence.find(s =>
        [
            'LISTENING',
            'RESPONDING',
            'INPUT-REQUIRED',
            'WAITING-SUBMISSION',
        ].includes(s.status)
    );
    return latestApi;
}

export function getFlowCompleteStatus(
    transactionData: TransactionCache,
    flow: Flow,
    flowStatus: MockStatusCode,
    mockSessionData: MockSessionCache
) {
    const apiList = reduceApiDataList(transactionData.apiList).sort(
        (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const subscriberType = transactionData.subscriberType;
    const refData = getReferenceData(mockSessionData, flow);
    const mappedFlow: FlowMap = {
        sequence: [],
        missedSteps: [],
        reference_data: refData,
    };
    const addedSequence = mockSessionData?.MORE_SEQUENCE || [];
    const flowSequence = [...flow.sequence, ...addedSequence];

    // Track the next expected step index in the flow
    let nextExpectedStepIndex = 0;

    // Process each API in chronological order
    for (const apiData of apiList) {
        if (apiData.entryType === 'API') {
            nextExpectedStepIndex = handleApiSequenceStrict(
                apiData,
                flowSequence,
                mappedFlow,
                nextExpectedStepIndex
            );
        } else {
            nextExpectedStepIndex = handleFormSequenceStrict(
                apiData,
                flowSequence,
                mappedFlow,
                nextExpectedStepIndex
            );
        }
    }

    // Add remaining pending steps that haven't been completed
    for (let i = nextExpectedStepIndex; i < flowSequence.length; i++) {
        addPendingStep(
            i,
            flowSequence[i],
            mappedFlow,
            subscriberType,
            flowStatus,
            nextExpectedStepIndex
        );
    }

    return mappedFlow;
}

function handleApiSequenceStrict(
    data: ReducedApiData,
    flowSequence: SequenceStep[],
    mappedFlow: FlowMap,
    nextExpectedStepIndex: number
): number {
    // Check if we have more steps to process in the flow
    if (nextExpectedStepIndex >= flowSequence.length) {
        // API is beyond the flow sequence
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.action,
            owner: data.action.startsWith('on_') ? 'BPP' : 'BAP',
            actionType: data.action,
            input: undefined,
            index: -1,
            unsolicited: false,
            pairActionId: null,
            description: 'action beyond flow sequence',
            missedStep: true,
            payloads: data,
        });
        return nextExpectedStepIndex;
    }

    const expectedStep = flowSequence[nextExpectedStepIndex];

    // Check if the API matches the next expected step
    if (expectedStep.type === data.action) {
        // Perfect match - add to sequence
        mappedFlow.sequence.push({
            status: 'COMPLETE',
            actionId: expectedStep.key,
            owner: expectedStep.owner,
            actionType: expectedStep.type,
            input: expectedStep.input,
            payloads: data,
            index: nextExpectedStepIndex,
            unsolicited: expectedStep.unsolicited,
            pairActionId: expectedStep.pair,
            description: expectedStep.description,
            label: expectedStep.label,
        });
        return nextExpectedStepIndex + 1;
    }

    // Check if this API exists later in the flow sequence
    const futureStepIndex = findStepInFlow(
        data.action,
        flowSequence,
        nextExpectedStepIndex
    );

    if (futureStepIndex !== -1) {
        // API exists in flow but is out of order - mark as missed step
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.action,
            owner: data.action.startsWith('on_') ? 'BPP' : 'BAP',
            actionType: data.action,
            input: undefined,
            index: futureStepIndex,
            unsolicited: false,
            pairActionId: null,
            description: `action executed out of order - expected at step ${futureStepIndex}, but step ${nextExpectedStepIndex} not completed`,
            missedStep: true,
            payloads: data,
        });
    } else {
        // API doesn't exist in the remaining flow - completely unexpected
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.action,
            owner: data.action.startsWith('on_') ? 'BPP' : 'BAP',
            actionType: data.action,
            input: undefined,
            index: -1,
            unsolicited: false,
            pairActionId: null,
            description: 'action not found in flow sequence',
            missedStep: true,
            payloads: data,
        });
    }

    // Return the same index since we didn't advance the flow
    return nextExpectedStepIndex;
}

function handleFormSequenceStrict(
    data: ReduceFormData,
    flowSequence: SequenceStep[],
    mappedFlow: FlowMap,
    nextExpectedStepIndex: number
): number {
    // Check if we have more steps to process in the flow
    if (nextExpectedStepIndex >= flowSequence.length) {
        // Form is beyond the flow sequence
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.formId,
            owner: 'BAP',
            actionType: data.formType,
            input: undefined,
            index: -1,
            unsolicited: false,
            pairActionId: null,
            description: 'form beyond flow sequence',
            missedStep: true,
            payloads: data,
        });
        return nextExpectedStepIndex;
    }

    const expectedStep = flowSequence[nextExpectedStepIndex];

    // Check if the form matches the next expected step
    if (expectedStep.type === data.formType) {
        // Perfect match - add to sequence
        mappedFlow.sequence.push({
            status: 'COMPLETE',
            actionId: expectedStep.key,
            owner: expectedStep.owner,
            actionType: expectedStep.type,
            input: expectedStep.input,
            index: nextExpectedStepIndex,
            unsolicited: expectedStep.unsolicited,
            pairActionId: expectedStep.pair,
            description: expectedStep.description,
            label: expectedStep.label,
            payloads: data,
        });
        return nextExpectedStepIndex + 1;
    }

    // Check if this form exists later in the flow sequence
    const futureStepIndex = findStepInFlow(
        data.formType,
        flowSequence,
        nextExpectedStepIndex
    );

    if (futureStepIndex !== -1) {
        // Form exists in flow but is out of order - mark as missed step
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.formId,
            owner: 'BAP',
            actionType: data.formType,
            input: undefined,
            index: futureStepIndex,
            unsolicited: false,
            pairActionId: null,
            description: `form executed out of order - expected at step ${futureStepIndex}, but step ${nextExpectedStepIndex} not completed`,
            missedStep: true,
            payloads: data,
        });
    } else {
        // Form doesn't exist in the remaining flow - completely unexpected
        mappedFlow.missedSteps.push({
            status: 'COMPLETE',
            actionId: data.formId,
            owner: 'BAP',
            actionType: data.formType,
            input: undefined,
            index: -1,
            unsolicited: false,
            pairActionId: null,
            description: 'form not found in flow sequence',
            missedStep: true,
            payloads: data,
        });
    }

    // Return the same index since we didn't advance the flow
    return nextExpectedStepIndex;
}

function findStepInFlow(
    actionType: string,
    flowSequence: SequenceStep[],
    startIndex: number
): number {
    for (let i = startIndex; i < flowSequence.length; i++) {
        if (flowSequence[i].type === actionType) {
            return i;
        }
    }
    return -1;
}

function addPendingStep(
    index: number,
    step: SequenceStep,
    mappedFlow: FlowMap,
    subscriberType: string,
    flowStatus: MockStatusCode,
    nextExpectedStepIndex: number
) {
    // Only add the very next expected step and mark others as waiting
    const base: MappedStep = {
        status: index === nextExpectedStepIndex ? 'LISTENING' : 'WAITING',
        actionId: step.key,
        owner: step.owner,
        actionType: step.type,
        input: step.input,
        index: index,
        unsolicited: step.unsolicited,
        pairActionId: step.pair,
        description: step.description,
        expect: step.expect,
        label: step.label,
        force_proceed: step.force_proceed,
        repeat: (step as any).repeat ?? 1,
    };

    if (index !== nextExpectedStepIndex) {
        // Steps that are not the immediate next step should be in WAITING status
        mappedFlow.sequence.push({
            ...base,
            status: 'WAITING',
        });
        return;
    }

    // Handle the next expected step based on type and ownership
    if (step.type === 'HTML_FORM' || step.type === 'DYNAMIC_FORM') {
        if (subscriberType === step.owner) {
            mappedFlow.sequence.push({
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'INPUT-REQUIRED'
                        : 'PROCESSING',
            });
        } else {
            mappedFlow.sequence.push({
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'WAITING-SUBMISSION'
                        : 'RESPONDING',
            });
        }
        return;
    }

    if (subscriberType === step.owner) {
        mappedFlow.sequence.push(base);
    } else {
        if (step.input) {
            mappedFlow.sequence.push({
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'INPUT-REQUIRED'
                        : 'RESPONDING',
            });
        } else {
            if (step.unsolicited) {
                mappedFlow.sequence.push({
                    ...base,
                    status:
                        flowStatus === 'AVAILABLE'
                            ? 'INPUT-REQUIRED'
                            : 'RESPONDING',
                    input: [],
                });
            }
            mappedFlow.sequence.push({
                ...base,
                status: 'RESPONDING',
            });
        }
    }
}

function reduceApiDataList(data: HistoryType[]): ApiHistory[] {
    const map = new Map<string, ApiHistory>();

    for (const vagueItem of data) {
        if (vagueItem.entryType === 'FORM') {
            const item = vagueItem as FormApiType;
            const key = `${item.formType}|${item.formId}|${item.submissionId}`;
            if (!map.has(key)) {
                map.set(key, {
                    entryType: 'FORM',
                    formType: item.formType,
                    formId: item.formId,
                    submissionId: item.submissionId,
                    timestamp: item.timestamp,
                    subStatus: item.error ? 'ERROR' : 'SUCCESS',
                    error: item.error,
                });
            }
        } else {
            const item = vagueItem;
            const key = `${item.action}|${item.messageId}`;
            if (!map.has(key)) {
                map.set(key, {
                    entryType: 'API',
                    action: item.action,
                    messageId: item.messageId,
                    timestamp: item.timestamp,
                    subStatus: checkPerfectAck(item.response),
                    payloads: [
                        {
                            payloadId: item.payloadId,
                            response: item.response,
                        },
                    ],
                });
            } else {
                const existingItem = map.get(key)! as ReducedApiData;
                existingItem.payloads.push({
                    payloadId: item.payloadId,
                    response: item.response,
                });
            }
        }
    }
    return Array.from(map.values());
}

function checkPerfectAck(response: unknown): 'SUCCESS' | 'ERROR' {
    if (response && typeof response === 'object' && 'message' in response) {
        const typedResponse = response as {
            message?: { ack?: { status?: string } };
        };
        if (typedResponse.message?.ack?.status === 'ACK') {
            return 'SUCCESS';
        }
    }
    return 'ERROR';
}
