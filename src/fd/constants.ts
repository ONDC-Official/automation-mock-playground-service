/**
 * Constants of the FD (ONDC:FIS14:FD, fixed deposits) branch of the playground.
 * Every FD code path is gated on `isFdDomain(domain)`; Beckn domains never reach it.
 */
export const FD_DOMAIN = 'ONDC:FIS14:FD';

export function isFdDomain(domain: string | undefined | null): boolean {
    return typeof domain === 'string' && domain.trim() === FD_DOMAIN;
}

/** Internal `X-Pwb-*` headers (M2-DESIGN §2). Express lower-cases incoming names. */
export const FD_HEADERS = {
    internalKey: 'X-Pwb-Internal-Key',
    route: 'X-Pwb-Fd-Route',
    pathParams: 'X-Pwb-Fd-Path-Params',
    method: 'X-Pwb-Fd-Method',
    path: 'X-Pwb-Fd-Path',
    replay: 'X-Pwb-Fd-Replay',
} as const;

/** Engine state and the inbound store live as long as the other transaction keys. */
export const FD_STATE_TTL_SECONDS = 5 * 60 * 60;

/** Session-data key the GENERATE job puts the engine's draft under. */
export const FD_DRAFT_SESSION_KEY = 'fd_draft';

/** Session-data key that holds the counterparty's SYNC answers, by step action id. */
export const FD_RESPONSES_SESSION_KEY = 'fd_responses';

/** `mock.defaultPayload` key that carries a negative step's scenario (D-4). Never sent. */
export const FD_SCENARIO_KEY = 'fdScenario';
