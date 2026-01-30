// import { validateRequest } from '../service/validator-service';
// import { MockRequest, OndcRequest } from '../types/request-types';
// import logger from '../utils/logger';
// import { getLoggerMeta } from '../utils/req-utils';
// import { Request, Response, NextFunction } from 'express';
// export async function receiveNewRequest(
//     req: Request,
//     res: Response,
//     next: NextFunction
// ) {
//     logger.info('Received retail search request.', getLoggerMeta(req));
//     const validationResult = await validateRequest(req);
//     if (!validationResult.valid) {
//         return next(validationResult.error);
//     }
//     (req as MockRequest).context = validationResult.data.body.context;
//     logger.info(
//         'Retail search request validated successfully.',
//         getLoggerMeta(req)
//     );
//     next();
// }
