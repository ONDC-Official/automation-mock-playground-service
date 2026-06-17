import { AsyncLocalStorage } from 'async_hooks';

/**
 * Request-scoped tracing metadata that is automatically merged into every log
 * line (see ./logger). Fields are filled in as they become known during the
 * lifetime of a request and propagated into the async jobs it spawns.
 */
export interface TraceContext {
    correlationId?: string;
    transactionId?: string;
    sessionId?: string;
    flowId?: string;
    /** The ONDC action name being acted on, e.g. `search`, `on_select`. */
    action?: string;
    /** The flow step identifier for that action (config `action_id`). */
    actionId?: string;
    messageId?: string;
    domain?: string;
    version?: string;
}

const als = new AsyncLocalStorage<TraceContext>();

/**
 * Opens a fresh trace-context store for the duration of `fn`. A new object is
 * created per call so stores never leak across requests/jobs.
 */
export function runWithTraceContext<T>(seed: TraceContext, fn: () => T): T {
    return als.run({ ...seed }, fn);
}

/** Returns the active trace context, or an empty object when none is open. */
export function getTraceContext(): TraceContext {
    return als.getStore() ?? {};
}

/**
 * Merges `partial` into the active store. No-op when called outside any store
 * (e.g. server-start logs, stray timers) so it is always safe to call.
 */
export function setTraceContext(partial: TraceContext): void {
    const store = als.getStore();
    if (store) Object.assign(store, partial);
}

export { als };
