import { NextFunction } from 'express';
import { fdControllers } from './fd-controller';
import { ApiRequest } from '../routes/manualRoutes';
import { getFdRoute, openFdTransaction, FdRouteInfo } from '../fd/engine';
import { scheduleFdAdvance } from '../fd/advance';
import { MockRunnerConfigCache } from '../service/cache/config-cache';
import { IQueueService } from '../queue/IQueueService';
import {
    fakeFdTxn,
    fakeRes,
    fakeRunner,
    FD,
    FD_VERSION,
    NP_URL,
    seedFd,
    TXN_ID,
} from '../fd/test-fixtures';

jest.mock('../fd/engine', () => ({
    ...jest.requireActual('../fd/engine'),
    getFdRoute: jest.fn(),
    openFdTransaction: jest.fn(),
}));
jest.mock('../fd/advance', () => ({
    ...jest.requireActual('../fd/advance'),
    scheduleFdAdvance: jest.fn(async () => true),
}));

const mockedGetRoute = getFdRoute as jest.MockedFunction<typeof getFdRoute>;
const mockedOpen = openFdTransaction as jest.MockedFunction<
    typeof openFdTransaction
>;
const mockedAdvance = scheduleFdAdvance as jest.MockedFunction<
    typeof scheduleFdAdvance
>;

const route = (
    action: string,
    mode: FdRouteInfo['mode'],
    kind: FdRouteInfo['kind'] = 'request'
): FdRouteInfo => ({
    action,
    kind,
    method: 'POST',
    path: `/${action}`,
    pathParams: [],
    mode,
    caller: 'INVESTOR_APP',
    callee: 'DEPOSIT_ISSUER',
    callback: null,
    inReplyTo: null,
});

const queue: IQueueService = {
    process: jest.fn(),
    enqueue: jest.fn(async () => 'job-1'),
    on: jest.fn(),
    close: jest.fn(),
};

function makeReq(
    ctx: ApiRequest['flowContext'],
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
): ApiRequest {
    const lower = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    return {
        flowContext: ctx,
        body,
        params: { action: (body.context as { action: string }).action },
        get: (name: string) => lower[name.toLowerCase()],
        headers: lower,
    } as unknown as ApiRequest;
}

const quoteRequest = {
    context: {
        domain: FD,
        version: FD_VERSION,
        action: 'quote_request',
        transaction_id: TXN_ID,
        message_id: 'm-req-1',
        bap_uri: NP_URL,
        timestamp: '2026-10-29T10:00:00.000Z',
    },
    fdEnvelope: { mode: 'SYNC', originatorRole: 'INVESTOR_APP' },
    message: { amount: 100000, tenureMonths: 12 },
};

const syncHeaders = {
    'X-Pwb-Fd-Route': 'quote_request',
    'X-Pwb-Fd-Method': 'POST',
    'X-Pwb-Fd-Path-Params': '{}',
};

describe('FD /manual/:action — SYNC answered inline', () => {
    it('observe → draft (answering) → step script on the draft → sent; responds with the body and its status', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const txn = fakeFdTxn({ httpStatus: 200 });
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(route('quote_request', 'SYNC'));
        const runner = fakeRunner(
            [
                {
                    action_id: 'quote_request',
                    mock: {
                        saveData: { requested_amount: '$.message.amount' },
                        defaultPayload: {
                            fdScenario: { expectError: 'FD-QUO-0001' },
                        },
                    },
                },
            ],
            (_id, session) => {
                const draft = session.fd_draft as Record<string, unknown>;
                return {
                    ...draft,
                    tweaked: session.requested_amount,
                    fdScenario: { must: 'not be sent' },
                };
            }
        );
        const mockRunnerCache = {
            getRunnerInstance: jest.fn(async () => runner),
        } as unknown as MockRunnerConfigCache;
        const controllers = fdControllers(
            workbenchCache,
            mockRunnerCache,
            queue
        );
        const res = fakeRes();
        const next = jest.fn() as NextFunction;

        await controllers.fdIncomingRequest(
            makeReq(ctx, quoteRequest, syncHeaders),
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        expect(txn.calls).toEqual(['observe', 'draft', 'sent', 'save']);

        // The step's scenario is applied when the request is decided, and again to the answer.
        const { scenario: decidedWith, ...inbound } =
            txn.observe.mock.calls[0][0];
        expect(decidedWith).toEqual({ expectError: 'FD-QUO-0001' });
        expect(inbound).toMatchObject({
            action: 'quote_request',
            method: 'POST',
            pathParams: {},
            body: quoteRequest,
        });
        expect(txn.draft).toHaveBeenCalledWith({
            action: 'quote_request',
            answering: inbound,
            scenario: { expectError: 'FD-QUO-0001' },
        });

        // The script ran on the draft, after the request's saveData.
        const [actionId, scriptSession] =
            runner.runGeneratePayloadWithSession.mock.calls[0];
        expect(actionId).toBe('quote_request');
        expect(scriptSession.fd_draft).toEqual(
            (await txn.draft.mock.results[0].value).body
        );
        expect(scriptSession.requested_amount).toEqual([100000]);

        // The answer: the tweaked draft, without fdScenario, with the draft's status.
        expect(res.status).toHaveBeenCalledWith(200);
        const sentBody = res.json.mock.calls[0][0];
        expect(sentBody.tweaked).toEqual([100000]);
        expect(sentBody).not.toHaveProperty('fdScenario');
        expect(txn.sent).toHaveBeenCalledWith({
            action: 'quote_request',
            body: sentBody,
            pathParams: {},
            answering: 'm-req-1',
        });

        // No queue; the flow moves on once the API service has recorded the exchange.
        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(mockedAdvance).toHaveBeenCalledWith(
            { workbenchCache, queue },
            {
                transactionId: TXN_ID,
                subscriberUrl: NP_URL,
                messageId: 'm-req-1',
            }
        );
    });

    it('answers a refused SYNC request with the NACK body and its status', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const nack = {
            context: { action: 'quote_request' },
            message: { ack: { status: 'NACK' } },
            error: { code: 'FD-QUO-0003' },
        };
        mockedOpen.mockResolvedValue(
            fakeFdTxn({ draftBody: nack, httpStatus: 200 })
        );
        mockedGetRoute.mockResolvedValue(route('quote_request', 'SYNC'));
        const runner = fakeRunner([
            { action_id: 'quote_request', mock: { saveData: {} } },
        ]);
        const controllers = fdControllers(
            workbenchCache,
            {
                getRunnerInstance: jest.fn(async () => runner),
            } as unknown as MockRunnerConfigCache,
            queue
        );
        const res = fakeRes();
        await controllers.fdIncomingRequest(
            makeReq(ctx, quoteRequest, syncHeaders),
            res,
            jest.fn()
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(nack);
    });

    it('answers with the engine draft alone when no flow step is pending for the action', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(route('portfolio_query', 'SYNC'));
        const getRunnerInstance = jest.fn();
        const controllers = fdControllers(
            workbenchCache,
            { getRunnerInstance } as unknown as MockRunnerConfigCache,
            queue
        );
        const res = fakeRes();
        const body = {
            ...quoteRequest,
            context: { ...quoteRequest.context, action: 'portfolio_query' },
        };
        await controllers.fdIncomingRequest(
            makeReq(ctx, body, {
                ...syncHeaders,
                'X-Pwb-Fd-Route': 'portfolio_query',
            }),
            res,
            jest.fn()
        );
        expect(getRunnerInstance).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
            (await txn.draft.mock.results[0].value).body
        );
        expect(txn.calls).toEqual(['observe', 'draft', 'sent', 'save']);
    });

    it('a replayed SYNC request gets the stored answer and does not move the flow', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const stored = {
            action: 'quote_request',
            body: { a: 1 },
            pathParams: {},
        };
        const txn = fakeFdTxn({ replayOf: 'm-req-1', stored });
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(route('quote_request', 'SYNC'));
        const controllers = fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        );
        const res = fakeRes();
        await controllers.fdIncomingRequest(
            makeReq(ctx, quoteRequest, syncHeaders),
            res,
            jest.fn()
        );
        expect(res.json).toHaveBeenCalledWith({ a: 1 });
        expect(txn.draft).not.toHaveBeenCalled();
        expect(mockedAdvance).not.toHaveBeenCalled();
    });

    it('stays well inside the 300 ms budget (playground overhead, engine mocked)', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        mockedGetRoute.mockResolvedValue(route('quote_request', 'SYNC'));
        const runner = fakeRunner([
            { action_id: 'quote_request', mock: { saveData: {} } },
        ]);
        const controllers = fdControllers(
            workbenchCache,
            {
                getRunnerInstance: jest.fn(async () => runner),
            } as unknown as MockRunnerConfigCache,
            queue
        );
        const timings: number[] = [];
        for (let i = 0; i < 100; i++) {
            mockedOpen.mockResolvedValue(fakeFdTxn());
            const t0 = process.hrtime.bigint();
            await controllers.fdIncomingRequest(
                makeReq(ctx, quoteRequest, syncHeaders),
                fakeRes(),
                jest.fn()
            );
            timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        timings.sort((a, b) => a - b);
        expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(300);
    });
});

describe('FD /manual/:action — async messages', () => {
    it('observes before the validate script, keeps the message for its callback, then continues', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(
            route('application_create', 'ASYNC_ACK_CALLBACK')
        );
        const controllers = fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        );
        const body = {
            ...quoteRequest,
            context: { ...quoteRequest.context, action: 'application_create' },
        };
        const res = fakeRes();
        const next = jest.fn();
        // fd-gate's forward of an async request may carry X-Pwb-Fd-Route too: not SYNC.
        await controllers.fdIncomingRequest(
            makeReq(ctx, body, { 'X-Pwb-Fd-Route': 'application_create' }),
            res,
            next
        );
        expect(txn.calls).toEqual(['observe', 'save']);
        expect(next).toHaveBeenCalledWith();
        expect(res.json).not.toHaveBeenCalled();
        const kept = await workbenchCache
            .FdCacheService()
            .getInbound(TXN_ID, NP_URL, 'application_create');
        expect(kept).toMatchObject({ action: 'application_create', body });
    });

    it('a SYNC route without fd-gate’s X-Pwb-Fd-Route header takes the async path', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(route('quote_request', 'SYNC'));
        const next = jest.fn();
        await fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        ).fdIncomingRequest(makeReq(ctx, quoteRequest), fakeRes(), next);
        expect(txn.draft).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith();
    });

    it('a replay is ACKed and does not advance the flow', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        mockedOpen.mockResolvedValue(fakeFdTxn({ replayOf: 'm-req-1' }));
        mockedGetRoute.mockResolvedValue(
            route('application_create', 'ASYNC_ACK_CALLBACK')
        );
        const body = {
            ...quoteRequest,
            context: { ...quoteRequest.context, action: 'application_create' },
        };
        const res = fakeRes();
        const next = jest.fn();
        await fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        ).fdIncomingRequest(makeReq(ctx, body), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            context: body.context,
            message: { ack: { status: 'ACK' } },
        });
        expect(
            await workbenchCache
                .FdCacheService()
                .getInbound(TXN_ID, NP_URL, 'application_create')
        ).toBeUndefined();
    });

    it('an engine failure on an FD message is passed on as an error, naming the cause', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        mockedGetRoute.mockRejectedValue(new Error('engine unavailable'));
        const next = jest.fn();
        await fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        ).fdIncomingRequest(makeReq(ctx, quoteRequest), fakeRes(), next);
        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'engine unavailable' })
        );
    });
});

describe('Beckn /manual/:action is untouched', () => {
    it('passes straight through without loading the engine', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const becknCtx = { ...ctx, domain: 'ONDC:RET10', version: '1.2.5' };
        const next = jest.fn();
        const res = fakeRes();
        await fdControllers(
            workbenchCache,
            {} as MockRunnerConfigCache,
            queue
        ).fdIncomingRequest(
            makeReq(becknCtx, {
                context: { action: 'search', message_id: 'm1' },
            }),
            res,
            next
        );
        expect(next).toHaveBeenCalledWith();
        expect(mockedGetRoute).not.toHaveBeenCalled();
        expect(mockedOpen).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});
