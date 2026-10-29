import { NextFunction, Request, Response } from 'express';
import { ApiRequest } from '../routes/manualRoutes';
import { IQueueService } from '../queue/IQueueService';
import { MockRunnerConfigCache } from '../service/cache/config-cache';
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import {
    httpValidationError,
    normalizeError,
    OndcProtocolError,
} from '../errors/custom-errors';
import { logError } from '../utils/req-utils';
import logger from '../utils/logger';
import { sendAck, sendRawBody, sendSuccess } from '../utils/res-utils';
import { FD_HEADERS, isFdDomain } from '../fd/constants';
import { actionOf, inboundFromRequest, messageIdOf } from '../fd/context';
import { getFdRoute } from '../fd/engine';
import {
    answerFdSync,
    isFdSyncRequest,
    observeIncomingFd,
} from '../fd/incoming';
import { scheduleFdAdvance } from '../fd/advance';
import { fdReplayBodySchema, replayFdCallback } from '../fd/replay';

/** A SYNC answer slower than this is logged: the local target is P95 < 300 ms. */
const SYNC_LATENCY_BUDGET_MS = 300;

export function fdControllers(
    workbenchCache: WorkbenchCacheServiceType,
    mockRunnerCache: MockRunnerConfigCache,
    queue: IQueueService
) {
    return {
        /**
         * `POST /manual/:action`, between `receivePayloadFromApiService` and
         * `validateAndSaveIncomingRequest`. Non-FD domains pass straight through.
         *
         * FD:
         * - SYNC request (fd-gate set `X-Pwb-Fd-Route` and the route's mode is SYNC): answered
         *   here, inline, with the engine's draft as tweaked by the step script;
         * - anything else: observed by the engine first; a replay is ACKed and not advanced;
         *   otherwise the regular validate/save/act path continues.
         */
        fdIncomingRequest: async (
            req: ApiRequest,
            res: Response,
            next: NextFunction
        ) => {
            const ctx = req.flowContext;
            if (!ctx || !isFdDomain(ctx.domain)) {
                next();
                return;
            }
            const started = Date.now();
            try {
                const action =
                    actionOf(req.body) ?? (req.params.action as string);
                const route = await getFdRoute(ctx.domain, ctx.version, action);
                const inbound = inboundFromRequest(req, action);
                const sync = isFdSyncRequest(req.get(FD_HEADERS.route), route);
                // An async request arrives with its body alone: its path parameters are where
                // fd-gate left them (consent_withdraw names its consent only by the path).
                if (!sync && !inbound.pathParams && route && route.pathParams.length > 0) {
                    const messageId = messageIdOf(req.body);
                    const stored = messageId
                        ? await workbenchCache
                              .FdCacheService()
                              .getPathParams(ctx.domain, ctx.transactionId, messageId)
                        : null;
                    if (stored) inbound.pathParams = stored;
                }

                if (sync) {
                    const answer = await answerFdSync(ctx, inbound, {
                        workbenchCache,
                        mockRunnerCache,
                    });
                    sendRawBody(res, answer.body, answer.httpStatus);
                    const elapsedMs = Date.now() - started;
                    const meta = {
                        transactionId: ctx.transactionId,
                        action,
                        elapsedMs,
                        httpStatus: answer.httpStatus,
                    };
                    if (elapsedMs > SYNC_LATENCY_BUDGET_MS) {
                        logger.warning('FD SYNC answer over budget', meta);
                    } else {
                        logger.info('FD SYNC answered inline', meta);
                    }
                    if (answer.advance && answer.requestMessageId) {
                        void scheduleFdAdvance(
                            { workbenchCache, queue },
                            {
                                transactionId: ctx.transactionId,
                                subscriberUrl: ctx.subscriberUrl,
                                messageId: answer.requestMessageId,
                            }
                        );
                    }
                    return;
                }

                const observation = await observeIncomingFd(
                    ctx,
                    inbound,
                    workbenchCache,
                    mockRunnerCache
                );
                if (observation.replayOf) {
                    logger.info(
                        'FD: replayed message, the flow is not advanced',
                        {
                            transactionId: ctx.transactionId,
                            action,
                            replayOf: observation.replayOf,
                        }
                    );
                    sendAck(res, req.body.context);
                    return;
                }
                next();
            } catch (error) {
                logError(req, 'FD incoming request failed', error);
                next(
                    normalizeError(
                        error,
                        new OndcProtocolError(
                            '31001',
                            'Error handling FD request',
                            'Unknown error'
                        )
                    )
                );
            }
        },

        /** `POST /fd/replay` (M2-DESIGN §6): re-send the callback sent for a request. */
        fdReplay: async (req: Request, res: Response, next: NextFunction) => {
            try {
                const parsed = fdReplayBodySchema.safeParse(req.body);
                if (!parsed.success) {
                    next(
                        new httpValidationError(
                            'Invalid FD replay request',
                            parsed.error.issues.map(
                                i => `${i.path.join('.')}: ${i.message}`
                            )
                        )
                    );
                    return;
                }
                const result = await replayFdCallback(parsed.data, {
                    workbenchCache,
                    queue,
                });
                sendSuccess(res, result, true);
            } catch (error) {
                logError(req, 'FD replay failed', error);
                next(error);
            }
        },
    };
}
