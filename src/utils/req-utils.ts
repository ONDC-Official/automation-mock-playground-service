import { Request } from 'express';
import logger from './logger';
import { ApiRequest } from '../routes/manualRoutes';

export function getLoggerMeta(req: Request) {
    return {
        correlationId: req.correlationId,
        transactionId: req.body?.context?.transaction_id,
        messageId: req.body?.context?.message_id,
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
