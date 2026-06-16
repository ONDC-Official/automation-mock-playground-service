import { Resolver } from './resolver-types';

export const sequenceResolver: Resolver = (ctx, state) => {
    const { apiData, flowSequence } = ctx;
    const cursor = state.cursor.value;

    if (cursor >= flowSequence.length) {
        return { consumed: false };
    }

    const expectedStep = flowSequence[cursor];

    if (apiData.entryType === 'API') {
        if (expectedStep.type === apiData.action) {
            state.mappedFlow.sequence.push({
                status: 'COMPLETE',
                actionId: expectedStep.key,
                owner: expectedStep.owner,
                actionType: expectedStep.type,
                input: expectedStep.input,
                payloads: apiData,
                index: cursor,
                unsolicited: expectedStep.unsolicited,
                pairActionId: expectedStep.pair,
                description: expectedStep.description,
                label: expectedStep.label,
            });
            state.cursor.value = cursor + 1;
            return { consumed: true };
        }
        return { consumed: false };
    }

    if (expectedStep.type === apiData.formType) {
        state.mappedFlow.sequence.push({
            status: 'COMPLETE',
            actionId: expectedStep.key,
            owner: expectedStep.owner,
            actionType: expectedStep.type,
            input: expectedStep.input,
            index: cursor,
            unsolicited: expectedStep.unsolicited,
            pairActionId: expectedStep.pair,
            description: expectedStep.description,
            label: expectedStep.label,
            payloads: apiData,
        });
        state.cursor.value = cursor + 1;
        return { consumed: true };
    }

    return { consumed: false };
};
