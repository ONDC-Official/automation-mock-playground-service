import { FormConfigType, SequenceStep } from '../../../types/flow-types';
import { MappedStep } from '../../../types/mapped-flow-types';
import { MockStatusCode } from '../../../types/mock-service-types';

/**
 * Synthetic input surfaced on a manual step once it becomes INPUT-REQUIRED.
 * Lets the UI detect it as an input (single `id` field, pre-filled with the
 * action id) so the user explicitly triggers the send via /flows/proceed.
 */
export function buildManualInput(actionId: string): FormConfigType {
    return [
        {
            name: 'manual_id',
            type: 'manual_id',
            schema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        default: actionId,
                        enum: [actionId],
                    },
                },
                required: ['id'],
                additionalProperties: false,
            },
        },
    ];
}

export interface BuildPendingStepArgs {
    step: SequenceStep;
    index: number;
    isImmediateNext: boolean;
    subscriberType: string;
    flowStatus: MockStatusCode;
}

export function buildPendingStep(args: BuildPendingStepArgs): MappedStep[] {
    const { step, index, isImmediateNext, subscriberType, flowStatus } = args;

    const base: MappedStep = {
        status: isImmediateNext ? 'LISTENING' : 'WAITING',
        actionId: step.key,
        owner: step.owner,
        actionType: step.type,
        input: step.input,
        index,
        unsolicited: step.unsolicited,
        pairActionId: step.pair,
        description: step.description,
        expect: step.expect,
        label: step.label,
        force_proceed: step.force_proceed,
        repeat: (step as unknown as { repeat?: number }).repeat ?? 1,
        manual: step.manual,
    };

    if (!isImmediateNext) {
        return [{ ...base, status: 'WAITING' }];
    }

    if (step.type === 'HTML_FORM' || step.type === 'DYNAMIC_FORM') {
        if (subscriberType === step.owner) {
            return [
                {
                    ...base,
                    status:
                        flowStatus === 'AVAILABLE'
                            ? 'INPUT-REQUIRED'
                            : 'PROCESSING',
                },
            ];
        }
        return [
            {
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'WAITING-SUBMISSION'
                        : 'RESPONDING',
            },
        ];
    }

    if (subscriberType === step.owner) {
        return [base];
    }

    if (step.input) {
        return [
            {
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'INPUT-REQUIRED'
                        : 'RESPONDING',
            },
        ];
    }

    // Manual takes precedence over unsolicited: a manual step must wait for an
    // explicit user trigger, so it must NOT also emit the unsolicited
    // auto-submit (empty-input) placeholder — that placeholder would be
    // auto-proceeded by the UI, bypassing the gate and looping on every poll.
    const manualGate = step.manual === true && flowStatus === 'AVAILABLE';
    if (manualGate) {
        return [
            {
                ...base,
                status: 'INPUT-REQUIRED',
                input: buildManualInput(step.key),
            },
        ];
    }

    // Unsolicited (AVAILABLE): emit a single auto-submit INPUT-REQUIRED
    // placeholder (empty input) — the UI auto-proceeds it to fire the send.
    // No RESPONDING twin: the placeholder alone drives the send, and the
    // stateless re-derivation replaces it with COMPLETE once the action lands.
    if (step.unsolicited) {
        return [
            {
                ...base,
                status:
                    flowStatus === 'AVAILABLE'
                        ? 'INPUT-REQUIRED'
                        : 'RESPONDING',
                input: [],
            },
        ];
    }
    return [{ ...base, status: 'RESPONDING' }];
}
