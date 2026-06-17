import baseLogger from '@ondc/automation-logger';
import { getTraceContext, TraceContext } from '../trace-context';

/**
 * Drop-in wrapper around `@ondc/automation-logger` that automatically merges
 * the active request/job trace context (transactionId, sessionId, actionId,
 * flowId, correlationId, …) into the metadata of every log line.
 *
 * The base package's `getFormattedMessage` scans log args for an object with a
 * `correlationId` to render the magenta `[C-ID: …]` prefix, so injecting the
 * trace object also preserves that prefix for free.
 *
 * Precedence: the trace object is appended/spread LAST with its `undefined`
 * keys removed. The active trace context is the request's canonical id source,
 * so its known ids win — and stripping undefined means a caller object (e.g.
 * `getLoggerData` with an unset `flowId`) can never clobber a real trace id.
 */
function definedTrace(): Partial<TraceContext> {
    const ctx = getTraceContext();
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}

const logger = {
    info(message: string, ...args: unknown[]): void {
        baseLogger.info(message, ...args, definedTrace());
    },

    debug(message: string, ...args: unknown[]): void {
        baseLogger.debug(message, ...args, definedTrace());
    },

    warning(message: string, ...args: unknown[]): void {
        baseLogger.warning(message, ...args, definedTrace());
    },

    error(message: string, meta?: unknown, error?: unknown): void {
        const mergedMeta = {
            ...((meta as Record<string, unknown>) ?? {}),
            ...definedTrace(),
        };
        baseLogger.error(message, mergedMeta, error);
    },

    startTimer() {
        return baseLogger.startTimer();
    },

    getCorrelationIdMiddleware() {
        return baseLogger.getCorrelationIdMiddleware();
    },
};

export default logger;
