import { MappedStep, ReducedApiData, ReduceFormData } from '../../../types/mapped-flow-types';
import { deriveOwnerFromAction } from './owner-utils';

export function makeApiMissedStep(
    data: ReducedApiData,
    opts:
        | { kind: 'OUT_OF_ORDER'; futureStepIndex: number; cursor: number }
        | { kind: 'NOT_FOUND' }
        | { kind: 'BEYOND' }
): MappedStep {
    if (opts.kind === 'OUT_OF_ORDER') {
        return {
            status: 'COMPLETE',
            actionId: data.action,
            owner: deriveOwnerFromAction(data.action),
            actionType: data.action,
            input: undefined,
            index: opts.futureStepIndex,
            unsolicited: false,
            pairActionId: null,
            description: `action executed out of order - expected at step ${opts.futureStepIndex}, but step ${opts.cursor} not completed`,
            missedStep: true,
            payloads: data,
        };
    }
    return {
        status: 'COMPLETE',
        actionId: data.action,
        owner: deriveOwnerFromAction(data.action),
        actionType: data.action,
        input: undefined,
        index: -1,
        unsolicited: false,
        pairActionId: null,
        description:
            opts.kind === 'BEYOND'
                ? 'action beyond flow sequence'
                : 'action not found in flow sequence',
        missedStep: true,
        payloads: data,
    };
}

export function makeFormMissedStep(
    data: ReduceFormData,
    opts:
        | { kind: 'OUT_OF_ORDER'; futureStepIndex: number; cursor: number }
        | { kind: 'NOT_FOUND' }
        | { kind: 'BEYOND' }
): MappedStep {
    if (opts.kind === 'OUT_OF_ORDER') {
        return {
            status: 'COMPLETE',
            actionId: data.formId,
            owner: 'BAP',
            actionType: data.formType,
            input: undefined,
            index: opts.futureStepIndex,
            unsolicited: false,
            pairActionId: null,
            description: `form executed out of order - expected at step ${opts.futureStepIndex}, but step ${opts.cursor} not completed`,
            missedStep: true,
            payloads: data,
        };
    }
    return {
        status: 'COMPLETE',
        actionId: data.formId,
        owner: 'BAP',
        actionType: data.formType,
        input: undefined,
        index: -1,
        unsolicited: false,
        pairActionId: null,
        description:
            opts.kind === 'BEYOND'
                ? 'form beyond flow sequence'
                : 'form not found in flow sequence',
        missedStep: true,
        payloads: data,
    };
}
