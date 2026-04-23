import logger from '@ondc/automation-logger';
import { NextFunction, Request, Response } from 'express';

const SKIP_PATHS = ['/health', '/metrics', '/memory', '/heapdump'];
const MAX_BODY_LOG_BYTES = 2048;
const PREVIEW_CHARS = 500;

const shouldSkip = (url: string): boolean => {
    const path = url.split('?')[0];
    return SKIP_PATHS.some(p => path === p || path.startsWith(p + '/'));
};

const summarizeBody = (body: unknown): Record<string, unknown> => {
    if (body == null) return { body: '(empty)' };

    let str: string;
    let size: number;
    let kind: string;

    if (Buffer.isBuffer(body)) {
        kind = 'Buffer';
        size = body.length;
        str = body.toString('utf8');
    } else if (typeof body === 'string') {
        kind = 'string';
        size = Buffer.byteLength(body, 'utf8');
        str = body;
    } else {
        kind = typeof body;
        try {
            str = JSON.stringify(body);
        } catch (err) {
            str = `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
        }
        size = Buffer.byteLength(str, 'utf8');
    }

    if (process.env.LOG_FULL_RESPONSE === 'true') {
        return { kind, size, body: str };
    }

    if (size <= MAX_BODY_LOG_BYTES) {
        return { kind, size, body: str };
    }

    return {
        kind,
        size,
        truncated: true,
        preview: str.slice(0, PREVIEW_CHARS),
    };
};

export const requestLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (shouldSkip(req.url)) return next();
    const { method, url, query } = req;
    logger.info(`[${method}] RequestLog=> ${url}`, { query });
    next();
};

export const responseLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (shouldSkip(req.url)) return next();
    const originalSend = res.send;

    res.send = function (body?: unknown): Response {
        logger.info(
            `[${req.method}] ResponseLog=> ${req.url} - Status: ${res.statusCode}`
        );
        logger.debug(`Response Body:`, summarizeBody(body));
        return originalSend.call(this, body);
    };

    next();
};
