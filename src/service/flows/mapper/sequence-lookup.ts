import { SequenceStep } from '../../../types/flow-types';

export function findStepInFlow(
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
