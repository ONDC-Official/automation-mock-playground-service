import baseLogger from '@ondc/automation-logger';
import { isAxiosError } from 'axios';
import { getStore } from './trace-context';

/**
 * Thin, drop-in wrapper around `@ondc/automation-logger` that auto-injects the
 * request-scoped trace envelope (transaction_id, session_id, domain, version,
 * …) into EVERY log line — including inside async job handlers — so logs are
 * traceable in Loki via `| json | transaction_id="..."`.
 *
 * Why this works (verified against the package internals):
 *   - `info/debug/warning(msg, ...args)` pass object args straight through to
 *     winston, whose `json()` format hoists them to top-level keys. So an extra
 *     leading context object becomes queryable fields.
 *   - `error(msg, meta, err)` merges `meta` into the emitted object.
 * Caller-supplied meta is spread AFTER the store, so explicit values win.
 *
 * The package is intentionally NOT modified — this lives entirely in-repo.
 */

const ctxObject = (): Record<string, unknown> | undefined => {
    const store = getStore();
    if (!store || Object.keys(store).length === 0) return undefined;
    // `correlationId` (camelCase) alias lets the package's dev formatter render
    // the `[C-ID: ...]` tag while `correlation_id` stays the Loki query field.
    return store.correlation_id
        ? { ...store, correlationId: store.correlation_id }
        : { ...store };
};

// Leading meta for every log: the trace envelope plus a clean `msg` field. The
// package colorizes the `message` arg (ANSI codes end up in the JSON `message`
// field), so `msg` carries the raw, human-readable text for Loki line_format.
const lead = (message: string): Record<string, unknown> => ({
    ...(ctxObject() ?? {}),
    msg: message,
});

export const log = {
    info(message: string, ...args: unknown[]): void {
        baseLogger.info(message, lead(message), ...args);
    },
    warning(message: string, ...args: unknown[]): void {
        baseLogger.warning(message, lead(message), ...args);
    },
    debug(message: string, ...args: unknown[]): void {
        baseLogger.debug(message, lead(message), ...args);
    },
    error(message: string, meta?: unknown, error?: unknown): void {
        const metaObj: Record<string, unknown> =
            meta === undefined || meta === null
                ? {}
                : typeof meta === 'object'
                  ? (meta as Record<string, unknown>)
                  : { meta };
        // The package DROPS `meta` entirely when `error` is an AxiosError (it
        // logs only { stack, axios_error } and returns early). Flatten the axios
        // error ourselves and call WITHOUT the 3rd arg, so the trace envelope /
        // event / job_name survive — otherwise every axios failure loses all
        // structured context (no event, no transaction_id, no correlation_id).
        if (isAxiosError(error)) {
            baseLogger.error(message, {
                ...lead(message),
                ...metaObj,
                error: error.message,
                stack: error.stack,
                axios_error: {
                    code: error.code,
                    request: {
                        method: error.config?.method,
                        url: error.config?.url,
                    },
                    response: {
                        status: error.response?.status,
                        statusText: error.response?.statusText,
                        data: error.response?.data,
                    },
                },
            });
            return;
        }
        baseLogger.error(message, { ...lead(message), ...metaObj }, error);
    },
    startTimer() {
        return baseLogger.startTimer();
    },
    getCorrelationIdMiddleware() {
        return baseLogger.getCorrelationIdMiddleware();
    },
    getFormattedMessage(
        message: string,
        level: 'info' | 'error' | 'debug' | 'warning',
        ...args: unknown[]
    ): string {
        return baseLogger.getFormattedMessage(message, level, ...args);
    },
};

export default log;
