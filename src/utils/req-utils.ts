import { Request } from 'express';
import logger from './logger';
import { ApiRequest } from '../routes/manualRoutes';
import { getTraceContext } from './trace-context';

export function getLoggerMeta(req: Request) {
    // Layer the active trace context underneath the request-derived fields so
    // explicit callers still get the full id set (the wrapper injects it too,
    // but this keeps the helper's output self-contained).
    const trace = getTraceContext();
    return {
        ...trace,
        correlationId: req.correlationId ?? trace.correlationId,
        transactionId: req.body?.context?.transaction_id ?? trace.transactionId,
        messageId: req.body?.context?.message_id ?? trace.messageId,
    };
}

export function getBecknContext(req: Request) {
    const context = req.body?.context || undefined;
    if (context === undefined) {
        logger.warning(
            'Beckn context is missing in the request body',
            getLoggerMeta(req)
        );
        return {};
    }
    return context;
}

export function logError(req: ApiRequest, message: string, error: unknown) {
    logger.error(message, getLoggerMeta(req), error);
}
