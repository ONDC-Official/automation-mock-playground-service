import logger from './logger';

export function isValidJson(
    value: unknown,
    loggerMeta?: Record<string, unknown>
): { valid: boolean; error?: string } {
    try {
        if (typeof value === 'string') {
            JSON.parse(value);
        } else {
            JSON.stringify(value);
        }
        return { valid: true };
    } catch (e) {
        logger.error('Invalid JSON value', loggerMeta, e);
        return {
            valid: false,
            error: (e as Error).message,
        };
    }
}
