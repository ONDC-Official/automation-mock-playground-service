import { NextFunction, Request, Response } from 'express';
import { sendError } from '../utils/res-utils';
import logger from '@ondc/automation-logger';

export function requireJsonContent(
    req: Request,
    res: Response,
    next: NextFunction
) {
    if (req.method !== 'POST') {
        next();
        return;
    }
    logger.info('Validating Content-Type header for JSON', {
        content: req.headers['content-type'],
    });
    if (req.headers['content-type'] !== 'application/json') {
        return sendError(
            res,
            'BAD_REQUEST',
            'Content-Type must be application/json'
        );
    }
    next();
}
