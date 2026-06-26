import { NextFunction, Request, Response } from 'express';
import { sendError, sendNack } from '../utils/res-utils';
import {
    httpValidationError,
    InternalServerError,
    isBodyParserJsonError,
    OndcProtocolError,
} from '../errors/custom-errors';
import { getBecknContext, getLoggerMeta } from '../utils/req-utils';
import logger from '../utils/logger';

export const globalErrorHandler = (
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    logger.error(
        'Error occurred while processing request',
        {
            ...getLoggerMeta(req),
        },
        err
    );
    if (res.headersSent) {
        return next(err);
    }

    if (isBodyParserJsonError(err)) {
        return sendError(res, 'BAD_REQUEST', 'Invalid JSON in request body', {
            details: 'Request body contains malformed JSON',
            jsonError: err.message,
        });
    }

    if (err instanceof httpValidationError) {
        const detailsBody =
            err.details && err.details.length > 0
                ? { details: err.details }
                : undefined;
        return sendError(res, 'BAD_REQUEST', err.message, detailsBody);
    }
    if (err instanceof InternalServerError) {
        return sendError(res, 'INTERNAL_ERROR', err.message);
    }

    if (err instanceof OndcProtocolError) {
        return sendNack(res, getBecknContext(req), err.code, err.customMessage);
    }
    return sendError(res, 'INTERNAL_ERROR');
};
