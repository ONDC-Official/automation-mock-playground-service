// // import { OndcRequest } from '../types/request-types';
import logger from '@ondc/automation-logger';
import { NextFunction, Request, Response } from 'express';

export const requestLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const { method, url, query } = req;
    logger.info(`[${method}] RequestLog=> ${url}`, { query });
    next();
};

export const responseLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const originalSend = res.send;

    res.send = function (body?: any): Response {
        logger.info(
            `[${req.method}] ResponseLog=> ${req.url} - Status: ${res.statusCode}`
        );
        logger.debug(`Response Body:`, {
            body: body ?? '(empty)',
        });
        return originalSend.call(this, body);
    };

    next();
};
