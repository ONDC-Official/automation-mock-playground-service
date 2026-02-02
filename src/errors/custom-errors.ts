import { OndcErrorCodeKey } from '../constants/error-codes';

export class OndcProtocolError extends Error {
    public code: OndcErrorCodeKey;
    public customMessage?: string;

    constructor(
        code: OndcErrorCodeKey,
        message: string,
        customMessage?: string
    ) {
        super(message);
        this.code = code;
        this.name = 'OndcProtocolError';
        this.customMessage = customMessage;
    }
}

export class httpValidationError extends Error {
    public details: string[];
    constructor(message: string, details: string[]) {
        super(message);
        this.name = 'httpValidationError';
        this.details = details;
    }
}

export class InternalServerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InternalServerError';
    }
}

interface BodyParserJsonError extends SyntaxError {
    type: 'entity.parse.failed';
    status?: number;
}

export function isBodyParserJsonError(
    err: unknown
): err is BodyParserJsonError {
    return (
        err instanceof SyntaxError &&
        typeof (err as unknown as Record<string, unknown>).type === 'string' &&
        (err as unknown as Record<string, unknown>).type ===
            'entity.parse.failed'
    );
}

export function normalizeError(
    error: unknown,
    fallback: OndcProtocolError
): Error {
    if (error instanceof Error) return error;
    return fallback;
}
