import { makeApiMissedStep, makeFormMissedStep } from '../missed-step-factory';
import { findStepInFlow } from '../sequence-lookup';
import { Resolver } from './resolver-types';

export const missedResolver: Resolver = (ctx, state) => {
    const { apiData, flowSequence } = ctx;
    const cursor = state.cursor.value;

    if (apiData.entryType === 'API') {
        if (cursor >= flowSequence.length) {
            state.mappedFlow.missedSteps.push(
                makeApiMissedStep(apiData, { kind: 'BEYOND' })
            );
            return { consumed: true };
        }
        const futureStepIndex = findStepInFlow(
            apiData.action,
            flowSequence,
            cursor
        );
        if (futureStepIndex !== -1) {
            state.mappedFlow.missedSteps.push(
                makeApiMissedStep(apiData, {
                    kind: 'OUT_OF_ORDER',
                    futureStepIndex,
                    cursor,
                })
            );
        } else {
            state.mappedFlow.missedSteps.push(
                makeApiMissedStep(apiData, { kind: 'NOT_FOUND' })
            );
        }
        return { consumed: true };
    }

    if (cursor >= flowSequence.length) {
        state.mappedFlow.missedSteps.push(
            makeFormMissedStep(apiData, { kind: 'BEYOND' })
        );
        return { consumed: true };
    }
    const futureStepIndex = findStepInFlow(
        apiData.formType,
        flowSequence,
        cursor
    );
    if (futureStepIndex !== -1) {
        state.mappedFlow.missedSteps.push(
            makeFormMissedStep(apiData, {
                kind: 'OUT_OF_ORDER',
                futureStepIndex,
                cursor,
            })
        );
    } else {
        state.mappedFlow.missedSteps.push(
            makeFormMissedStep(apiData, { kind: 'NOT_FOUND' })
        );
    }
    return { consumed: true };
};
