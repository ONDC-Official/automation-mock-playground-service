import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { httpValidationError } from '../errors/custom-errors';
import { getLoggerData } from '../utils/logger/winston/loggerUtils';

function validateRequiredParams(params: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const missingParams = params.filter(param => !req.query[param]);
        if (missingParams.length > 0) {
            logger.error('Missing required parameters', getLoggerData(req), {
                missingParams,
            });
            return next(
                new httpValidationError('Missing required parameters', params)
            );
        }
        next();
    };
}

export default validateRequiredParams;
