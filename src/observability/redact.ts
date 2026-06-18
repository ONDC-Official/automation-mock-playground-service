/**
 * Body capture helpers for ingress/egress logging: redaction of sensitive keys
 * + size-capped serialization. Keeps payloads out of the danger zone (the
 * express json limit is 3mb; we cap logged bodies far below that).
 */

const DEFAULT_MAX_BYTES = 16384;
const PREVIEW_CHARS = 1000;

const REDACT_KEYS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'signature',
    'x-gateway-authorization',
    'password',
    'token',
    'access_token',
    'refresh_token',
    'secret',
    'client_secret',
    'api_key',
    'apikey',
    'x-api-key',
]);

const REDACTED = '[REDACTED]';

export type BodyLogMode = 'off' | 'ingress' | 'egress' | 'all';

export function bodyLogMode(): BodyLogMode {
    const v = (process.env.OBS_LOG_BODIES || 'egress').toLowerCase();
    if (v === 'off' || v === 'ingress' || v === 'egress' || v === 'all') {
        return v;
    }
    return 'egress';
}

/** Whether bodies of the given direction should be captured, per config. */
export function shouldLogBody(direction: 'ingress' | 'egress'): boolean {
    const mode = bodyLogMode();
    return mode === 'all' || mode === direction;
}

function maxBytes(): number {
    const n = Number(process.env.LOG_BODY_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Recursively clone `value`, replacing sensitive keys with `[REDACTED]`. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
        return value.map(item => redact(item, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = REDACT_KEYS.has(key.toLowerCase())
            ? REDACTED
            : redact(val, seen);
    }
    return out;
}

/**
 * Returns a log-safe summary of a body: redacted + either the full payload (if
 * small) or a truncated preview, always with the original byte size.
 */
export function capBody(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) {
        return { size: 0, body: null };
    }
    const redacted = redact(value);
    let str: string;
    try {
        str =
            typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    } catch (err) {
        str = `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
    }
    const size = Buffer.byteLength(str ?? '', 'utf8');
    if (size <= maxBytes()) {
        return { size, truncated: false, payload: redacted };
    }
    return { size, truncated: true, preview: str.slice(0, PREVIEW_CHARS) };
}
