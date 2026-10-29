/**
 * The ONE place the playground touches the FD engine, `@ondc/fd-contract` (M2-DESIGN §7).
 *
 * Everything else in the playground uses the types and functions below. If the engine's API
 * changes, only this file should need to.
 *
 * Mapping to the engine:
 * - the package is loaded lazily with `require('@ondc/fd-contract')`, on the first FD use, so
 *   a missing or unbuilt package fails that FD call with `FdEngineUnavailableError` and never
 *   affects startup or Beckn domains;
 * - `createEngine({spec, routes, identity, role, counterparty})`, one engine per
 *   (domain, version, role), cached; spec from `FD_SPEC`, routes from the config service or
 *   `FD_ROUTE_TABLE` (see fd-config.ts), identity from env, role from the session's `npType`;
 * - per transaction, `openFdTransaction` loads the state from Redis DB 0
 *   (`FD_ENGINE_STATE::<transactionId>::<subscriberUrl>`, 5 h) with `deserialiseFdState`, or
 *   starts one with `engine.initialState(transactionId)`; `observe`, `draft`, `sent` and
 *   `replayFor` call the engine's; `save()` writes the state back with `serialiseFdState`;
 * - the engine keeps `observe`'s findings in the state it returns, so they persist with it.
 */
import { InternalServerError } from '../errors/custom-errors';
import logger from '../utils/logger';
import { fdRegistryKeyLookup } from './registry';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import { FD_STATE_TTL_SECONDS } from './constants';
import {
    FdConfigError,
    FdIdentity,
    FdRole,
    fdIdentity,
    fdRoleForNpType,
    fetchFdRouteTableSource,
    readFdSpecSource,
} from './fd-config';

export type { FdRole } from './fd-config';

// ── The engine's API, as the playground uses it (M2-DESIGN §7) ─────────────

/** Opaque to the playground: only the engine reads it. */
export type FdState = unknown;

export interface FdInbound {
    body: unknown;
    action: string;
    method: string;
    pathParams?: Record<string, string>;
    query?: Record<string, string>;
    httpStatus?: number;
    receivedAt?: string;
    /** For a SYNC answer: the workbench request it answers. */
    requestMessageId?: string;
}

export interface FdFinding {
    rule?: string;
    detail?: string;
    errorCode?: string;
    fieldPath?: string;
    requirementIds?: string[];
    messageId?: string;
    action?: string;
    [k: string]: unknown;
}

export interface FdScenario {
    expectError?: string;
    mutate?: string[];
    withhold?: boolean;
    [k: string]: unknown;
}

export interface FdCounterparty {
    subscriberId?: string;
    subscriberUri?: string;
}

export interface FdDraftRequest {
    action: string;
    answering?: FdInbound;
    scenario?: FdScenario;
    userInputs?: unknown;
}

export interface FdDraft {
    body: Record<string, unknown>;
    pathParams: Record<string, string>;
    /** Set on SYNC answers only. */
    httpStatus?: number;
}

export interface FdSentMessage {
    action: string;
    body: unknown;
    pathParams?: Record<string, string>;
    /** The request's `message_id`, when this answers one. */
    answering?: string;
    replay?: boolean;
}

export interface FdStoredMessage {
    action: string;
    body: unknown;
    pathParams: Record<string, string>;
}

export interface FdObservation {
    findings: FdFinding[];
    replayOf?: string;
}

/** One route-table entry (FD-ROUTE-TABLE.md). */
export interface FdRouteInfo {
    action: string;
    kind: 'request' | 'callback' | 'webhook';
    method: 'GET' | 'POST';
    path: string;
    pathParams: string[];
    mode: 'SYNC' | 'ASYNC_ACK_CALLBACK' | 'WEBHOOK';
    caller: string;
    callee: string;
    callback: string | null;
    inReplyTo: string | null;
}

interface EngineConfig {
    spec: unknown;
    routes: unknown;
    identity: FdIdentity;
    role: FdRole;
    /** Registry signing-key lookup, to verify an issuer's quote signature (investor-app role). */
    keyLookup?: (subscriberId: string, uniqueKeyId: string) => Promise<string>;
}

interface FdEngine {
    initialState?(transactionId: string): FdState;
    observe(
        state: FdState,
        msg: FdInbound
    ): Promise<{ state: FdState; findings?: FdFinding[]; replayOf?: string }>;
    draft(
        state: FdState,
        req: FdDraftRequest & { counterparty?: FdCounterparty }
    ): Promise<{ state: FdState } & FdDraft>;
    sent(state: FdState, msg: FdSentMessage): FdState;
    replayFor(
        state: FdState,
        requestMessageId: string
    ): FdStoredMessage | undefined;
    serialise?(state: FdState): string;
    deserialise?(text: string): FdState;
}

interface RouteIndex {
    find(action: string): FdRouteInfo | undefined;
}

interface FdContractModule {
    createEngine(cfg: EngineConfig): FdEngine;
    loadRouteTable(input: unknown): RouteIndex;
    serialiseFdState?(state: FdState): string;
    deserialiseFdState?(text: string): FdState;
    emptyFdState?(transactionId: string): FdState;
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** An InternalServerError, so a request that hits it gets a 500 naming the cause. */
export class FdEngineUnavailableError extends InternalServerError {
    constructor(message: string, cause?: unknown) {
        super(
            `[FD] the FD engine (@ondc/fd-contract) is unavailable: ${message}` +
                (cause instanceof Error ? ` (${cause.message})` : '')
        );
        this.name = 'FdEngineUnavailableError';
    }
}

let contract: FdContractModule | null = null;

function loadContract(): FdContractModule {
    if (contract) return contract;
    let mod: Partial<FdContractModule>;
    try {
        // Loaded on first FD use, never at startup: Beckn domains must not depend on it.
        // eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
        mod = require('@ondc/fd-contract');
    } catch (e) {
        throw new FdEngineUnavailableError(
            'require("@ondc/fd-contract") failed; install it and build its CommonJS output (npm run build in automation-fd-contract)',
            e
        );
    }
    if (
        typeof mod.createEngine !== 'function' ||
        typeof mod.loadRouteTable !== 'function'
    ) {
        throw new FdEngineUnavailableError(
            'the package does not export createEngine and loadRouteTable'
        );
    }
    contract = mod as FdContractModule;
    return contract;
}

const routeIndexes = new Map<string, Promise<RouteIndex>>();
const engines = new Map<string, Promise<FdEngine>>();

function routeIndexFor(domain: string, version: string): Promise<RouteIndex> {
    const key = `${domain}::${version}`;
    let index = routeIndexes.get(key);
    if (!index) {
        index = (async () => {
            const source = await fetchFdRouteTableSource(domain, version);
            return loadContract().loadRouteTable(source);
        })();
        index.catch(() => routeIndexes.delete(key));
        routeIndexes.set(key, index);
    }
    return index;
}

function engineFor(
    domain: string,
    version: string,
    role: FdRole
): Promise<FdEngine> {
    const key = `${domain}::${version}::${role}`;
    let engine = engines.get(key);
    if (!engine) {
        engine = (async () => {
            const spec = await readFdSpecSource();
            const routes = await routeIndexFor(domain, version);
            let created: FdEngine;
            try {
                const keyLookup = fdRegistryKeyLookup();
                created = loadContract().createEngine({
                    spec,
                    routes,
                    identity: fdIdentity(role, domain, version),
                    role,
                    ...(keyLookup && { keyLookup }),
                });
            } catch (e) {
                // The engine fails closed (e.g. the issuer role without signing keys); keep
                // its reason in the 500 a request gets.
                throw new FdConfigError(
                    `cannot create the FD engine for ${role} (${domain} ${version}): ${(e as Error).message}`
                );
            }
            logger.info('FD engine created', { domain, version, role });
            return created;
        })();
        engine.catch(() => engines.delete(key));
        engines.set(key, engine);
    }
    return engine;
}

/** The route-table entry for an FD action, or undefined when the action isn't in the table. */
export async function getFdRoute(
    domain: string,
    version: string,
    action: string
): Promise<FdRouteInfo | undefined> {
    return (await routeIndexFor(domain, version)).find(action);
}

// ── Per-transaction handle ──────────────────────────────────────────────────

export interface FdTransactionKey {
    domain: string;
    version: string;
    transactionId: string;
    /** The NP's subscriber URL: the transaction cache's key part. */
    subscriberUrl: string;
    npType: 'BAP' | 'BPP';
    /** The NP under test, passed to every draft (the engine keeps it after first use). */
    counterparty?: FdCounterparty;
}

export interface FdTransaction {
    readonly role: FdRole;
    observe(msg: FdInbound): Promise<FdObservation>;
    draft(req: FdDraftRequest): Promise<FdDraft>;
    sent(msg: FdSentMessage): void;
    replayFor(requestMessageId: string): FdStoredMessage | undefined;
    /** Writes the state back to Redis (5 h TTL). */
    save(): Promise<void>;
}

/** Loads (or starts) the engine state of one FD transaction. */
export async function openFdTransaction(
    workbenchCache: WorkbenchCacheServiceType,
    key: FdTransactionKey
): Promise<FdTransaction> {
    const role = fdRoleForNpType(key.npType);
    const engine = await engineFor(key.domain, key.version, role);
    const mod = loadContract();
    const fdCache = workbenchCache.FdCacheService();

    const deserialise = (text: string): FdState => {
        if (mod.deserialiseFdState) return mod.deserialiseFdState(text);
        if (engine.deserialise) return engine.deserialise(text);
        throw new FdEngineUnavailableError('no deserialiseFdState export');
    };
    const serialise = (s: FdState): string => {
        if (mod.serialiseFdState) return mod.serialiseFdState(s);
        if (engine.serialise) return engine.serialise(s);
        throw new FdEngineUnavailableError('no serialiseFdState export');
    };

    const stored = await fdCache.getEngineState(
        key.transactionId,
        key.subscriberUrl
    );
    let state: FdState;
    if (stored) {
        state = deserialise(stored);
    } else if (engine.initialState) {
        state = engine.initialState(key.transactionId);
    } else if (mod.emptyFdState) {
        state = mod.emptyFdState(key.transactionId);
    } else {
        throw new FdEngineUnavailableError('no initialState / emptyFdState');
    }

    return {
        role,
        async observe(msg) {
            const out = await engine.observe(state, msg);
            state = out.state;
            return { findings: out.findings ?? [], replayOf: out.replayOf };
        },
        async draft(req) {
            const out = await engine.draft(state, {
                ...req,
                ...(key.counterparty ? { counterparty: key.counterparty } : {}),
            });
            state = out.state;
            return {
                body: out.body,
                pathParams: out.pathParams ?? {},
                httpStatus: out.httpStatus,
            };
        },
        sent(msg) {
            state = engine.sent(state, msg);
        },
        replayFor(requestMessageId) {
            return engine.replayFor(state, requestMessageId);
        },
        async save() {
            await fdCache.setEngineState(
                key.transactionId,
                key.subscriberUrl,
                serialise(state),
                FD_STATE_TTL_SECONDS
            );
        },
    };
}

/** Test hook: forget the loaded package, engines and route indexes. */
export function resetFdEngineCache(): void {
    contract = null;
    routeIndexes.clear();
    engines.clear();
}
