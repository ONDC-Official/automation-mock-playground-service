import { Resolver } from './resolver-types';

/**
 * FD only: a re-send of a message (`fdReplay`) that no step of its own consumed — a webhook
 * delivered several times at once (scenario 12), or a callback re-sent for a replayed request —
 * belongs to the step that recorded the message: its payloads are added to that step. Beckn
 * history never carries `fdReplay`, so Beckn flows never reach it.
 */
export const fdReplayResolver: Resolver = (ctx, state) => {
    const { apiData } = ctx;
    if (apiData.entryType !== 'API' || apiData.fdReplay !== true) {
        return { consumed: false };
    }
    for (let i = state.mappedFlow.sequence.length - 1; i >= 0; i--) {
        const step = state.mappedFlow.sequence[i];
        const recorded = step.payloads;
        if (
            step.status === 'COMPLETE' &&
            recorded?.entryType === 'API' &&
            recorded.action === apiData.action &&
            recorded.messageId === apiData.messageId
        ) {
            recorded.payloads.push(...apiData.payloads);
            return { consumed: true };
        }
    }
    return { consumed: false };
};
