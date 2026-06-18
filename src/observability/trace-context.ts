import { AsyncLocalStorage } from 'async_hooks';
import type { FlowContext } from '../types/process-flow-types';

/**
 * Request-scoped trace envelope. Every field is optional because it is filled
 * in progressively as a request flows through the pipeline:
 *   - `correlation_id` is seeded first (pre-body-parse),
 *   - the Beckn/flow identifiers are added once the body is parsed,
 *   - `session_id` / `flow_id` / `subscriber_url` are added once the controller
 *     resolves them from cache.
 *
 * These are LOG-BODY fields (snake_case, queried in Loki via `| json |
 * transaction_id="..."`). They are intentionally NOT Loki stream labels nor
 * Prometheus labels — see src/observability/metrics.ts for the cardinality rule.
 */
export interface TraceContext {
    correlation_id?: string;
    transaction_id?: string;
    message_id?: string;
    session_id?: string;
    flow_id?: string;
    domain?: string;
    version?: string;
    action?: string;
    subscriber_url?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

const isMeaningful = (v: unknown): boolean =>
    v !== undefined && v !== null && v !== '';

/**
 * Establish a new trace context for the duration of `fn` (and every async
 * continuation spawned from it). One call per HTTP request and per job consume.
 */
export function run<T>(ctx: TraceContext, fn: () => T): T {
    return storage.run({ ...ctx }, fn);
}

export function getStore(): TraceContext | undefined {
    return storage.getStore();
}

/**
 * Enrich the CURRENT trace context in place. No-op when called outside a
 * `run()` scope (e.g. startup logs) so callers never need to guard.
 */
export function set(partial: Partial<TraceContext>): void {
    const store = storage.getStore();
    if (!store) return;
    for (const [key, value] of Object.entries(partial)) {
        if (isMeaningful(value)) {
            (store as Record<string, unknown>)[key] = value;
        }
    }
}

/** Plain-object copy of the current context — for embedding in job messages. */
export function snapshot(): TraceContext {
    return { ...(storage.getStore() ?? {}) };
}

export function fromFlowContext(fc: FlowContext): TraceContext {
    return {
        transaction_id: fc.transactionId,
        session_id: fc.sessionId,
        flow_id: fc.flowId,
        domain: fc.domain,
        version: fc.version,
        subscriber_url: fc.subscriberUrl,
    };
}

/**
 * Best-effort extraction of trace identifiers from a raw request body. Handles
 * both shapes used by this service:
 *   - ONDC envelope:   body.context.{transaction_id,message_id,domain,version,action}
 *   - flow endpoints:  body.{transaction_id,session_id,flow_id}
 */
export function fromBecknContext(body: unknown): TraceContext {
    const b = (body ?? {}) as Record<string, unknown>;
    const ctx = (b.context ?? {}) as Record<string, unknown>;
    const out: TraceContext = {
        transaction_id:
            (ctx.transaction_id as string) ?? (b.transaction_id as string),
        message_id: ctx.message_id as string,
        domain: ctx.domain as string,
        version: (ctx.version as string) ?? (ctx.core_version as string),
        action: ctx.action as string,
        session_id: b.session_id as string,
        flow_id: (b.flow_id as string) ?? (ctx.flow_id as string),
    };
    // strip empties so we never overwrite good values with blanks
    for (const key of Object.keys(out) as (keyof TraceContext)[]) {
        if (!isMeaningful(out[key])) delete out[key];
    }
    return out;
}

export const trace = {
    run,
    getStore,
    set,
    snapshot,
    fromFlowContext,
    fromBecknContext,
};

export default trace;
