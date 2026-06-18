import logger from '../observability/log';
import { NextFunction, Request, Response } from 'express';
import { capBody, shouldLogBody } from '../observability/redact';

const SKIP_PATHS = [
    '/health',
    '/metrics',
    '/memory',
    '/heapdump',
    '/mock/playground/flows/current-status',
];

const shouldSkip = (url: string): boolean => {
    const path = url.split('?')[0];
    return SKIP_PATHS.some(p => path === p || path.startsWith(p + '/'));
};

/**
 * Logs a structured `ingress` line per request. Runs before body parsing, so it
 * carries method/path/query only; the request body (when opt-in) is captured in
 * `responseLogger` once it has been parsed.
 */
export const requestLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (shouldSkip(req.url)) return next();
    logger.info('ingress', {
        event: 'ingress',
        component: 'http',
        http: { method: req.method, path: req.path },
        query: req.query,
    });
    next();
};

/**
 * Logs a structured `response` line (status + duration) on send, plus an opt-in
 * debug line carrying the redacted+capped request and response bodies (enabled
 * via OBS_LOG_BODIES=ingress|all).
 */
export const responseLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (shouldSkip(req.url)) return next();
    const start = Date.now();
    const originalSend = res.send;

    res.send = function (body?: unknown): Response {
        const durationMs = Date.now() - start;
        // One queryable line per request: method/path/status/duration + params,
        // plus request/response bodies when OBS_LOG_BODIES includes `ingress`.
        // Bodies are redacted + size-capped by capBody.
        const captureBodies = shouldLogBody('ingress');
        logger.info('response', {
            event: 'response',
            component: 'http',
            http: {
                method: req.method,
                path: req.path,
                status: res.statusCode,
                duration_ms: durationMs,
            },
            query: req.query,
            ...(captureBodies
                ? { request: capBody(req.body), response: capBody(body) }
                : {}),
        });
        return originalSend.call(this, body);
    };

    next();
};
