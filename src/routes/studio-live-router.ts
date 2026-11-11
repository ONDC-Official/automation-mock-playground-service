import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';

import ServiceContainer from '../container/container';
import { normalizeError, OndcProtocolError } from '../errors/custom-errors';
import {
    findLiveRun,
    getLiveFlowStatus,
    isLiveSession,
    LiveDeps,
    proceedLiveFlow,
    receiveLivePayload,
    startLiveFlow,
} from '../service/studio-live/live-session';
import { BecknContext } from '../types/ondc-types';
import { computeSubscriber } from '../utils/flow-utils';
import logger from '../utils/logger';
import { sendAck, sendError, sendNack, sendSuccess } from '../utils/res-utils';

/**
 * Protocol Studio live sessions (`engine: "graph-v2"`), mounted in front of the
 * v1 routers on the same paths. Each handler looks at the session first and
 * calls `next()` for anything that is not a graph-v2 session, so v1 sessions
 * reach their own routers untouched — and the api-service and the UI backend
 * talk to the same URLs for both.
 */

const startBody = z.object({
    session_id: z.string(),
    flow_id: z.string(),
    transaction_id: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    step_through: z.boolean().optional(),
});

const proceedBody = z.object({
    session_id: z.string(),
    transaction_id: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    form_data: z.record(z.string(), z.unknown()).optional(),
    trigger_extra: z.string().optional(),
    finish: z.boolean().optional(),
    step_through: z.boolean().optional(),
    settings_only: z.boolean().optional(),
});

const statusQuery = z.object({
    session_id: z.string(),
    transaction_id: z.string(),
});

export const createStudioLiveRouter = (deps: () => LiveDeps) => {
    const router = Router();

    const isLive = async (sessionId: unknown) => {
        if (typeof sessionId !== 'string' || !sessionId) return false;
        try {
            const session = await deps()
                .workbench.NpSessionalCacheService()
                .getSessionData(sessionId);
            return await isLiveSession(deps(), sessionId, session);
        } catch {
            return false;
        }
    };

    // The live page shows this message as is, so it says what failed and why.
    const fail =
        (what: string, res: Response) =>
        (error: unknown, next: NextFunction) => {
            logger.error(`studio live: ${what} failed`, {}, error);
            if (error instanceof z.ZodError)
                return sendError(
                    res,
                    'BAD_REQUEST',
                    `Live ${what}: invalid request · ${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
                );
            if (error instanceof Error)
                return sendError(
                    res,
                    'INTERNAL_ERROR',
                    `Live ${what} failed · ${error.message}`
                );
            next(
                normalizeError(
                    error,
                    new OndcProtocolError(
                        '31001',
                        `Error in live session: ${what}`,
                        'Unknown error'
                    )
                )
            );
        };

    router.post(
        '/flows/new',
        async (req: Request, res: Response, next: NextFunction) => {
            if (!(await isLive(req.body?.session_id))) return next();
            try {
                const body = startBody.parse(req.body);
                const result = await startLiveFlow(deps(), {
                    sessionId: body.session_id,
                    journeyId: body.flow_id,
                    ...(body.transaction_id
                        ? { transactionId: body.transaction_id }
                        : {}),
                    ...(body.inputs ? { inputs: body.inputs } : {}),
                    ...(body.step_through !== undefined
                        ? { stepThrough: body.step_through }
                        : {}),
                });
                sendSuccess(res, result, true);
            } catch (error) {
                fail('start', res)(error, next);
            }
        }
    );

    router.post(
        '/flows/proceed',
        async (req: Request, res: Response, next: NextFunction) => {
            if (!(await isLive(req.body?.session_id))) return next();
            try {
                const body = proceedBody.parse(req.body);
                const result = await proceedLiveFlow(deps(), {
                    sessionId: body.session_id,
                    transactionId: body.transaction_id,
                    ...(body.inputs ? { inputs: body.inputs } : {}),
                    ...(body.form_data ? { formData: body.form_data } : {}),
                    ...(body.trigger_extra
                        ? { triggerExtra: body.trigger_extra }
                        : {}),
                    ...(body.finish ? { finish: true } : {}),
                    ...(body.step_through !== undefined
                        ? { stepThrough: body.step_through }
                        : {}),
                    ...(body.settings_only ? { settingsOnly: true } : {}),
                });
                sendSuccess(res, result, true);
            } catch (error) {
                fail('proceed', res)(error, next);
            }
        }
    );

    router.get(
        '/flows/current-status',
        async (req: Request, res: Response, next: NextFunction) => {
            if (!(await isLive(req.query.session_id))) return next();
            try {
                const query = statusQuery.parse(req.query);
                sendSuccess(
                    res,
                    await getLiveFlowStatus(
                        deps(),
                        query.session_id,
                        query.transaction_id
                    ),
                    true
                );
            } catch (error) {
                fail('status', res)(error, next);
            }
        }
    );

    // The participant's payloads, forwarded by the api-service.
    router.post(
        '/manual/:action',
        async (req: Request, res: Response, next: NextFunction) => {
            const context = req.body?.context as BecknContext | undefined;
            if (!context?.transaction_id || !context.action) return next();
            let subscriberUrl: string;
            try {
                subscriberUrl = computeSubscriber(context);
            } catch {
                return next();
            }
            const found = await findLiveRun(
                deps(),
                context.transaction_id,
                subscriberUrl
            ).catch(() => null);
            if (!found) return next();
            try {
                const result = await receiveLivePayload(
                    deps(),
                    req.body,
                    subscriberUrl
                );
                switch (result.kind) {
                    case 'not-live':
                        return next();
                    case 'accepted':
                        sendSuccess(
                            res,
                            {
                                success: true,
                                message: `Received ${result.nodeId}`,
                                jobIds: [result.jobId],
                            },
                            true
                        );
                        return;
                    case 'invalid':
                        // As v1: the error goes back as a callback; the request itself is ACKed.
                        sendAck(res, context);
                        return;
                    case 'rejected':
                        sendNack(res, context, '20008', result.reason);
                        return;
                }
            } catch (error) {
                // The api-service sent this: answer in ONDC terms, with the cause.
                logger.error('studio live: receive failed', {}, error);
                sendNack(
                    res,
                    context,
                    '31001',
                    `Live receive failed · ${error instanceof Error ? error.message : 'Unknown error'}`
                );
            }
        }
    );

    return router;
};

const container = ServiceContainer.getInstance();

const studioLiveRouter = createStudioLiveRouter(() => ({
    cache: container.getCacheService0(),
    workbench: container.getWorkbenchCacheService(),
    queue: container.getQueueService(),
}));

export default studioLiveRouter;
