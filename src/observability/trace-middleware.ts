import { NextFunction, Request, Response } from 'express';
import { run, set, fromBecknContext } from './trace-context';
import {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight,
    lbl,
} from './metrics';

// Ops endpoints are excluded from RED metrics and tracing noise.
const SKIP_PATHS = new Set(['/health', '/metrics', '/memory', '/heapdump']);
const shouldSkip = (path: string): boolean => SKIP_PATHS.has(path);

/**
 * Opens the request-scoped trace context. MUST run before body parsing (the
 * Beckn identifiers are added later by `seedBecknContext`). Wrapping `next()`
 * in `run()` means every downstream middleware, controller, and async
 * continuation in this request shares one mutable context.
 */
export function seedCorrelation(
    req: Request,
    _res: Response,
    next: NextFunction
): void {
    run({ correlation_id: req.correlationId }, () => next());
}

/**
 * Enriches the open trace context from the parsed request body. MUST run after
 * `express.json()`. Never blocks the request on enrichment failure.
 */
export function seedBecknContext(
    req: Request,
    _res: Response,
    next: NextFunction
): void {
    try {
        set(fromBecknContext(req.body));
    } catch {
        // trace enrichment is best-effort; never fail a request because of it
    }
    next();
}

function routeTemplate(req: Request): string {
    const route = (req as unknown as { route?: { path?: string } }).route;
    const base = req.baseUrl || '';
    if (route?.path) return base + route.path;
    return base || req.path;
}

/** Records HTTP RED metrics (rate, errors, duration) per route template. */
export function httpMetricsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (shouldSkip(req.path)) return next();

    const endTimer = httpRequestDuration.startTimer();
    httpRequestsInFlight.inc();
    let finalized = false;

    const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        httpRequestsInFlight.dec();
        const labels = {
            method: req.method,
            route: lbl(routeTemplate(req)),
            status: String(res.statusCode),
        };
        httpRequestsTotal.inc(labels);
        endTimer(labels);
    };

    res.on('finish', finalize);
    res.on('close', finalize);
    next();
}
