import { NextFunction, Request, Response } from 'express';
import { BackdoorService } from '../service/backdoor-service';
import { clearFlowsQuerySchema } from '../types/backdoor-types';
import { sendError, sendSuccess } from '../utils/res-utils';
import logger from '../utils/logger';
import { httpValidationError } from '../errors/custom-errors';

export const backdoorControllers = (backdoorService: BackdoorService) => ({
    clearFlowsController: async (
        req: Request,
        res: Response,
        next: NextFunction
    ) => {
        try {
            const queryResult = clearFlowsQuerySchema.safeParse(req.query);

            if (!queryResult.success) {
                next(
                    new httpValidationError('Invalid query parameters', [
                        queryResult.error.message,
                    ])
                );
                return;
            }

            const result = await backdoorService.clearFlowCache(
                queryResult.data
            );

            return sendSuccess(res, result);
        } catch (error) {
            logger.error('Error clearing flow cache', req.query, error);
            return sendError(
                res,
                'INTERNAL_ERROR',
                'Failed to clear flow cache',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
        }
    },
});
