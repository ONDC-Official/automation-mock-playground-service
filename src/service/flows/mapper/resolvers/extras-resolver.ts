import { SequenceStep } from '../../../../types/flow-types';
import { MappedStep } from '../../../../types/mapped-flow-types';
import { buildPendingStep } from '../pending-step';
import { Resolver } from './resolver-types';

const FORM_TYPES = new Set(['HTML_FORM', 'DYNAMIC_FORM', 'HTML_FORM_MULTI']);

export interface ExtrasIndex {
    byType: Map<string, SequenceStep>;
    byKey: Map<string, SequenceStep>;
}

export interface ExtrasState {
    // key: `${stepKey}::${messageId}` → list of indices in mappedFlow.extraSteps
    pendingPlaceholders: Map<string, number[]>;
}

export function createExtrasIndex(extraSequence: SequenceStep[]): ExtrasIndex {
    const byType = new Map<string, SequenceStep>();
    const byKey = new Map<string, SequenceStep>();

    for (const step of extraSequence) {
        if (FORM_TYPES.has(step.type)) {
            throw new Error(
                `extraSequence entry "${step.key}" has form-type "${step.type}"; forms must live only in strict sequence`
            );
        }
        if (byType.has(step.type)) {
            const existing = byType.get(step.type)!;
            throw new Error(
                `extraSequence has duplicate type "${step.type}" (keys: "${existing.key}" and "${step.key}")`
            );
        }
        byType.set(step.type, step);
        byKey.set(step.key, step);
    }

    return { byType, byKey };
}

export function createEmptyExtrasState(): ExtrasState {
    return { pendingPlaceholders: new Map() };
}

export function createExtrasResolver(
    index: ExtrasIndex,
    extrasState: ExtrasState
): Resolver {
    return (ctx, state) => {
        const { apiData } = ctx;

        if (apiData.entryType !== 'API') {
            return { consumed: false };
        }

        const extraStep = index.byType.get(apiData.action);
        if (!extraStep) {
            return { consumed: false };
        }

        if (!state.mappedFlow.extraSteps) {
            state.mappedFlow.extraSteps = [];
        }
        const extraSteps = state.mappedFlow.extraSteps;

        // Try resolving an existing placeholder for this (step, messageId).
        const placeholderKey = `${extraStep.key}::${apiData.messageId}`;
        const matchingIndices =
            extrasState.pendingPlaceholders.get(placeholderKey);
        if (matchingIndices && matchingIndices.length > 0) {
            for (const idx of matchingIndices) {
                const ph = extraSteps[idx];
                ph.status = 'COMPLETE';
                ph.payloads = apiData;
            }
            extrasState.pendingPlaceholders.delete(placeholderKey);
            return { consumed: true };
        }

        // ADD path: push COMPLETE entry for the matched extra step.
        extraSteps.push({
            status: 'COMPLETE',
            actionId: extraStep.key,
            owner: extraStep.owner,
            actionType: extraStep.type,
            input: extraStep.input,
            payloads: apiData,
            index: -1,
            unsolicited: extraStep.unsolicited,
            pairActionId: extraStep.pair,
            description: extraStep.description,
            label: extraStep.label,
            isExtraStep: true,
        });

        if (!extraStep.pair) {
            return { consumed: true };
        }

        const pairStep = index.byKey.get(extraStep.pair);
        if (!pairStep) {
            // Asymmetric / dangling pair reference — tolerated; no placeholder created.
            return { consumed: true };
        }

        // If the pair step has already COMPLETED for this messageId, skip placeholder.
        const pairAlreadyComplete = extraSteps.some(
            (s: MappedStep) =>
                s.actionId === pairStep.key &&
                s.status === 'COMPLETE' &&
                s.payloads?.entryType === 'API' &&
                s.payloads.messageId === apiData.messageId
        );
        if (pairAlreadyComplete) {
            return { consumed: true };
        }

        const pairStatus =
            ctx.extraFlowStatuses?.get(pairStep.key) ?? ctx.flowStatus;
        const placeholders = buildPendingStep({
            step: pairStep,
            index: -1,
            isImmediateNext: true,
            subscriberType: ctx.subscriberType,
            flowStatus: pairStatus,
        });

        const pairKey = `${pairStep.key}::${apiData.messageId}`;
        for (const ph of placeholders) {
            ph.isExtraStep = true;
            ph.awaitingMessageId = apiData.messageId;
            ph.pairActionId = pairStep.pair;

            const idx = extraSteps.length;
            extraSteps.push(ph);

            const existing = extrasState.pendingPlaceholders.get(pairKey) ?? [];
            existing.push(idx);
            extrasState.pendingPlaceholders.set(pairKey, existing);
        }

        return { consumed: true };
    };
}
