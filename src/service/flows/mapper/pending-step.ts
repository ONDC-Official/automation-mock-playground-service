import { SequenceStep } from '../../../types/flow-types';
import { MappedStep } from '../../../types/mapped-flow-types';
import { MockStatusCode } from '../../../types/mock-service-types';

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

    const out: MappedStep[] = [];
    if (step.unsolicited) {
        out.push({
            ...base,
            status:
                flowStatus === 'AVAILABLE' ? 'INPUT-REQUIRED' : 'RESPONDING',
            input: [],
        });
    }
    out.push({ ...base, status: 'RESPONDING' });
    return out;
}
