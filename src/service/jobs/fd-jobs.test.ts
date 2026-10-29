import axios from 'axios';
import {
    createGeneratePayloadJobHandler,
    createGenerationRequestCompleteHandler,
    GenerateMockPayloadJobResult,
} from './generate-response';
import {
    ApiServiceRequestJobParams,
    createApiServiceRequestJobHandler,
    SEND_TO_API_SERVICE_JOB,
} from './api-service-request';
import { getFdRoute, openFdTransaction, FdRouteInfo } from '../../fd/engine';
import { scheduleFdAdvance } from '../../fd/advance';
import { MockRunnerConfigCache } from '../cache/config-cache';
import { IQueueService, QueueJob } from '../../queue/IQueueService';
import { MappedStep } from '../../types/mapped-flow-types';
import {
    fakeFdTxn,
    fakeRunner,
    FD,
    FD_VERSION,
    NP_ID,
    NP_URL,
    SESSION_ID,
    seedFd,
    TXN_ID,
} from '../../fd/test-fixtures';

jest.mock('../../fd/engine', () => ({
    ...jest.requireActual('../../fd/engine'),
    getFdRoute: jest.fn(),
    openFdTransaction: jest.fn(),
}));
jest.mock('../../fd/advance', () => ({
    ...jest.requireActual('../../fd/advance'),
    scheduleFdAdvance: jest.fn(async () => true),
}));

const mockedGetRoute = getFdRoute as jest.MockedFunction<typeof getFdRoute>;
const mockedOpen = openFdTransaction as jest.MockedFunction<
    typeof openFdTransaction
>;
const mockedAdvance = scheduleFdAdvance as jest.MockedFunction<
    typeof scheduleFdAdvance
>;

const route = (over: Partial<FdRouteInfo>): FdRouteInfo => ({
    action: 'x',
    kind: 'request',
    method: 'POST',
    path: '/x',
    pathParams: [],
    mode: 'ASYNC_ACK_CALLBACK',
    caller: 'INVESTOR_APP',
    callee: 'DEPOSIT_ISSUER',
    callback: null,
    inReplyTo: null,
    ...over,
});

const mappedStep = (actionId: string, owner: 'BAP' | 'BPP'): MappedStep => ({
    status: 'RESPONDING',
    actionId,
    actionType: actionId,
    owner,
    index: 2,
    unsolicited: false,
    pairActionId: null,
});

function queueSpy(): IQueueService & { enqueue: jest.Mock } {
    return {
        process: jest.fn(),
        enqueue: jest.fn(async () => 'job-1'),
        on: jest.fn(),
        close: jest.fn(),
    };
}

const callbackDraft = {
    context: { action: 'on_application_create', message_id: 'm-cb-1' },
    fdEnvelope: { inReplyTo: 'm-req-1' },
    message: { application: { applicationId: 'APP-1', version: 1 } },
};

afterEach(() => {
    delete process.env.PWB_INTERNAL_KEY;
});

describe('FD GENERATE job: draft → script → sent', () => {
    it('drafts answering the stored request, runs the script on fd_draft, drops fdScenario, records sent', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const request = {
            body: {
                context: {
                    action: 'application_create',
                    message_id: 'm-req-1',
                },
            },
            action: 'application_create',
            method: 'POST',
        };
        await workbenchCache
            .FdCacheService()
            .setInbound(TXN_ID, NP_URL, 'application_create', request, 60);

        const txn = fakeFdTxn({
            draftBody: callbackDraft,
            pathParams: { applicationId: 'APP-1' },
        });
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(
            route({
                action: 'on_application_create',
                kind: 'callback',
                inReplyTo: 'application_create',
                caller: 'DEPOSIT_ISSUER',
                callee: 'INVESTOR_APP',
            })
        );
        const runner = fakeRunner(
            [
                {
                    action_id: 'on_application_create',
                    mock: {
                        defaultPayload: {
                            fdScenario: { mutate: ['/message/x'] },
                        },
                    },
                },
            ],
            (_id, session) => ({
                ...(session.fd_draft as object),
                tweak: 'by script',
                fdScenario: { mutate: ['/message/x'] },
            })
        );
        const configCache = {
            getRunnerInstance: jest.fn(async () => runner),
        } as unknown as MockRunnerConfigCache;

        const handler = createGeneratePayloadJobHandler(
            workbenchCache,
            configCache
        );
        const result = (await handler({
            flowContext: ctx,
            actionMeta: mappedStep('on_application_create', 'BPP'),
            inputs: { amount: 5 },
        })) as GenerateMockPayloadJobResult;

        expect(txn.draft).toHaveBeenCalledWith({
            action: 'on_application_create',
            answering: request,
            scenario: { mutate: ['/message/x'] },
            userInputs: { amount: 5 },
        });
        const scriptSession =
            runner.runGeneratePayloadWithSession.mock.calls[0][1];
        expect(scriptSession.fd_draft).toEqual(callbackDraft);

        expect(result.payload).toEqual({
            ...callbackDraft,
            tweak: 'by script',
        });
        expect(result.payload).not.toHaveProperty('fdScenario');
        expect(txn.calls).toEqual(['draft', 'sent', 'save']);
        expect(txn.sent).toHaveBeenCalledWith({
            action: 'on_application_create',
            body: result.payload,
            pathParams: { applicationId: 'APP-1' },
            answering: 'm-req-1',
        });
        expect(result.fd).toEqual({
            pathParams: { applicationId: 'APP-1' },
            actionId: 'on_application_create',
        });

        // The engine's draft is not persisted into the session.
        const session = await workbenchCache
            .TxnBusinessCacheService()
            .getMockSessionData(TXN_ID, NP_URL, SESSION_ID);
        expect(session).not.toHaveProperty('fd_draft');
    });

    it('fails the job (and frees the step) when the engine is unavailable', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        mockedGetRoute.mockRejectedValue(new Error('[FD] engine unavailable'));
        const configCache = {
            getRunnerInstance: jest.fn(async () => fakeRunner([])),
        } as unknown as MockRunnerConfigCache;
        await workbenchCache
            .FlowStatusCacheService()
            .setFlowStatus(TXN_ID, NP_URL, 'WORKING');
        await expect(
            createGeneratePayloadJobHandler(
                workbenchCache,
                configCache
            )({
                flowContext: ctx,
                actionMeta: mappedStep('on_application_create', 'BPP'),
            })
        ).rejects.toThrow('[FD] engine unavailable');
        const status = await workbenchCache
            .FlowStatusCacheService()
            .getFlowStatus(TXN_ID, NP_URL, {});
        expect(status.status).toBe('AVAILABLE');
    });

    it('the complete handler passes the FD metadata to the send job', async () => {
        const { workbenchCache, ctx } = await seedFd('BAP');
        const queue = queueSpy();
        const configCache = {
            getMockRunnerConfig: jest.fn(async () => ({
                steps: [
                    {
                        action_id: 'on_application_create',
                        mock: { saveData: {} },
                    },
                ],
            })),
        } as unknown as MockRunnerConfigCache;
        const job = {
            id: 'j1',
            jobName: 'GENERATE_PAYLOAD_JOB',
            timestamp: new Date(),
            data: {
                flowContext: ctx,
                actionMeta: mappedStep('on_application_create', 'BPP'),
            },
        } as QueueJob<never>;
        await createGenerationRequestCompleteHandler(
            queue,
            workbenchCache,
            configCache
        )(job, {
            success: true,
            message: 'ok',
            payload: callbackDraft,
            fd: { pathParams: { applicationId: 'APP-1' } },
        });
        expect(queue.enqueue).toHaveBeenCalledWith(
            SEND_TO_API_SERVICE_JOB,
            expect.objectContaining({
                action: 'on_application_create',
                domain: FD,
                payload: callbackDraft,
                fd: { pathParams: { applicationId: 'APP-1' } },
            })
        );
    });

    it('a workbench SYNC request carries the hook that observes the answer', async () => {
        const { workbenchCache, ctx } = await seedFd('BPP');
        const draft = {
            context: { action: 'quote_request', message_id: 'm-q-1' },
            message: { amount: 1 },
        };
        mockedOpen.mockResolvedValue(fakeFdTxn({ draftBody: draft }));
        mockedGetRoute.mockResolvedValue(
            route({ action: 'quote_request', mode: 'SYNC' })
        );
        const result = (await createGeneratePayloadJobHandler(workbenchCache, {
            getRunnerInstance: jest.fn(async () =>
                fakeRunner([{ action_id: 'quote_request', mock: {} }])
            ),
        } as unknown as MockRunnerConfigCache)({
            flowContext: ctx,
            actionMeta: mappedStep('quote_request', 'BAP'),
        })) as GenerateMockPayloadJobResult;
        expect(result.fd).toEqual({
            pathParams: {},
            actionId: 'quote_request',
            syncAnswer: {
                key: expect.objectContaining({
                    transactionId: TXN_ID,
                    subscriberUrl: NP_URL,
                    npType: 'BPP',
                    counterparty: {
                        subscriberId: NP_ID,
                        subscriberUri: NP_URL,
                    },
                }),
                sessionId: SESSION_ID,
                actionId: 'quote_request',
                method: 'POST',
                requestMessageId: 'm-q-1',
            },
        });
    });
});

describe('SEND job headers', () => {
    const base: ApiServiceRequestJobParams = {
        action: 'on_application_create',
        domain: FD,
        version: FD_VERSION,
        payload: callbackDraft,
        subscriberUrl: NP_URL,
        queryParams: { subscriber_url: NP_URL },
    };

    it('FD: adds X-Pwb-Internal-Key and X-Pwb-Fd-Path-Params', async () => {
        process.env.PWB_INTERNAL_KEY = 'secret-key';
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 202, data: {} });
        await createApiServiceRequestJobHandler()({
            ...base,
            fd: { pathParams: { applicationId: 'APP-1' } },
        });
        expect(post.mock.calls[0][2]?.headers).toEqual({
            'X-Pwb-Internal-Key': 'secret-key',
            'X-Pwb-Fd-Path-Params': '{"applicationId":"APP-1"}',
            'Content-Type': 'application/json',
        });
        // FD bodies go as the text the job serialised, so it can be kept for replays.
        expect(post.mock.calls[0][1]).toBe(JSON.stringify(callbackDraft));
    });

    it('FD replay: adds X-Pwb-Fd-Replay: 1', async () => {
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 202, data: {} });
        await createApiServiceRequestJobHandler()({
            ...base,
            fd: { pathParams: {}, replay: true },
        });
        expect(post.mock.calls[0][2]?.headers).toEqual({
            'X-Pwb-Fd-Path-Params': '{}',
            'X-Pwb-Fd-Replay': '1',
            'Content-Type': 'application/json',
        });
    });

    it('FD replay: sends the original text verbatim, and an accepted send keeps its text', async () => {
        const { workbenchCache } = await seedFd('BAP');
        const queue = queueSpy();
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 200, data: {} });
        const payload = {
            ...callbackDraft,
            context: { ...callbackDraft.context, transaction_id: TXN_ID },
        };
        await createApiServiceRequestJobHandler({ workbenchCache, queue })({
            ...base,
            payload,
            fd: { pathParams: {} },
        });
        const kept = await workbenchCache
            .FdCacheService()
            .getSentRaw(TXN_ID, NP_URL, 'm-cb-1');
        expect(kept).toBe(JSON.stringify(payload));

        const original = '{"b":1,  "a":2}';
        await createApiServiceRequestJobHandler({ workbenchCache, queue })({
            ...base,
            payload,
            fd: { pathParams: {}, replay: true, rawBody: original },
        });
        expect(post.mock.calls[1][1]).toBe(original);
    });

    it('Beckn: no X-Pwb headers, request unchanged', async () => {
        process.env.PWB_INTERNAL_KEY = 'secret-key';
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 200, data: {} });
        await createApiServiceRequestJobHandler()({
            ...base,
            domain: 'ONDC:RET10',
            version: '1.2.5',
            action: 'on_search',
        });
        expect(post).toHaveBeenCalledWith(
            expect.stringContaining('/ONDC:RET10/1.2.5/mock/on_search'),
            callbackDraft,
            { params: { subscriber_url: NP_URL } }
        );
    });
});

describe('SEND job: the NP’s SYNC answer to a workbench request', () => {
    it('is observed, saved as the step result, and moves the flow on', async () => {
        const { workbenchCache } = await seedFd('BPP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        const answer = {
            context: { action: 'quote_request', message_id: 'm-ans-1' },
            fdEnvelope: { inReplyTo: 'm-q-1' },
            message: { quote: { quoteId: 'Q-9' } },
        };
        jest.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: answer,
        });
        const queue = queueSpy();
        const key = {
            domain: FD,
            version: FD_VERSION,
            transactionId: TXN_ID,
            subscriberUrl: NP_URL,
            npType: 'BPP' as const,
        };
        const result = await createApiServiceRequestJobHandler({
            workbenchCache,
            queue,
        })({
            action: 'quote_request',
            domain: FD,
            version: FD_VERSION,
            payload: { context: { message_id: 'm-q-1' } },
            subscriberUrl: NP_URL,
            fd: {
                pathParams: {},
                syncAnswer: {
                    key,
                    sessionId: SESSION_ID,
                    actionId: 'quote_request',
                    method: 'POST',
                    requestMessageId: 'm-q-1',
                },
            },
        });

        expect(result).toMatchObject({ success: true, statusCode: 200 });
        expect(mockedOpen).toHaveBeenCalledWith(workbenchCache, key);
        expect(txn.observe).toHaveBeenCalledWith(
            expect.objectContaining({
                body: answer,
                action: 'quote_request',
                method: 'POST',
                httpStatus: 200,
                requestMessageId: 'm-q-1',
            })
        );
        expect(txn.calls).toEqual(['observe', 'save']);
        const session = await workbenchCache
            .TxnBusinessCacheService()
            .getMockSessionData(TXN_ID, NP_URL, SESSION_ID);
        expect(session.fd_responses).toEqual({ quote_request: answer });
        expect(mockedAdvance).toHaveBeenCalledWith(
            { workbenchCache, queue },
            { transactionId: TXN_ID, subscriberUrl: NP_URL, messageId: 'm-q-1' }
        );
    });
});

describe('SEND job: an accepted FD send moves the flow on', () => {
    const send = (
        deps: Parameters<typeof createApiServiceRequestJobHandler>[0],
        fd: object
    ) =>
        createApiServiceRequestJobHandler(deps)({
            action: 'on_application_create',
            domain: FD,
            version: FD_VERSION,
            payload: {
                context: { transaction_id: TXN_ID, message_id: 'm-cb-1' },
            },
            subscriberUrl: NP_URL,
            fd: { pathParams: {}, ...fd },
        });

    it('a callback the API service accepted dispatches the next step once recorded', async () => {
        const { workbenchCache } = await seedFd('BAP');
        jest.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: { message: { ack: { status: 'ACK' } } },
        });
        const queue = queueSpy();
        await send({ workbenchCache, queue }, {});
        expect(mockedAdvance).toHaveBeenCalledWith(
            { workbenchCache, queue },
            {
                transactionId: TXN_ID,
                subscriberUrl: NP_URL,
                messageId: 'm-cb-1',
            }
        );
    });

    it('a replayed message and a refused send do not move the flow', async () => {
        const { workbenchCache } = await seedFd('BAP');
        const queue = queueSpy();
        jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
        await send({ workbenchCache, queue }, { replay: true });
        jest.spyOn(axios, 'post').mockRejectedValue(
            Object.assign(new Error('400'), {
                isAxiosError: true,
                response: { status: 400, data: {} },
            })
        );
        await send({ workbenchCache, queue }, {});
        expect(mockedAdvance).not.toHaveBeenCalled();
    });
});

describe('M6 scenarios in the GENERATE job', () => {
    const generate = async (
        scenario: Record<string, unknown>,
        draftBody: Record<string, unknown>,
        inputs?: unknown
    ) => {
        const { workbenchCache, ctx } = await seedFd('BPP');
        const txn = fakeFdTxn({ draftBody });
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(
            route({ action: 'nominee_register', mode: 'ASYNC_ACK_CALLBACK' })
        );
        const runner = fakeRunner(
            [
                {
                    action_id: 'nominee_register_2',
                    mock: { defaultPayload: { fdScenario: scenario } },
                },
            ],
            (_id, session) => session.fd_draft as object
        );
        const result = (await createGeneratePayloadJobHandler(workbenchCache, {
            getRunnerInstance: jest.fn(async () => runner),
        } as unknown as MockRunnerConfigCache)({
            flowContext: ctx,
            actionMeta: mappedStep('nominee_register_2', 'BAP'),
            inputs,
        })) as GenerateMockPayloadJobResult;
        return { txn, result, workbenchCache };
    };

    it('retry: the engine’s re-send is recorded as a replay and sent as the original text', async () => {
        const original = '{"context":{"message_id":"m-nr-1"},  "message":{}}';
        const { workbenchCache, ctx } = await seedFd('BPP');
        await workbenchCache
            .FdCacheService()
            .setSentRaw(TXN_ID, NP_URL, 'm-nr-1', original, 60);
        const txn = fakeFdTxn({
            draftBody: { context: { message_id: 'm-nr-1' }, message: {} },
        });
        mockedOpen.mockResolvedValue(txn);
        mockedGetRoute.mockResolvedValue(route({ action: 'nominee_register' }));
        const result = (await createGeneratePayloadJobHandler(workbenchCache, {
            getRunnerInstance: jest.fn(async () =>
                fakeRunner(
                    [
                        {
                            action_id: 'nominee_register_2',
                            mock: {
                                defaultPayload: { fdScenario: { retry: true } },
                            },
                        },
                    ],
                    (_id, session) => session.fd_draft as object
                )
            ),
        } as unknown as MockRunnerConfigCache)({
            flowContext: ctx,
            actionMeta: mappedStep('nominee_register_2', 'BAP'),
        })) as GenerateMockPayloadJobResult;
        expect(txn.sent).toHaveBeenCalledWith(
            expect.objectContaining({ replay: true })
        );
        expect(result.fd).toEqual({
            pathParams: {},
            actionId: 'nominee_register_2',
            resend: true,
            rawBody: original,
        });
        expect(txn.release).toHaveBeenCalled();
    });

    it('deliveries: the send job is told to deliver n copies', async () => {
        const { result } = await generate(
            { deliveries: 5 },
            { context: { message_id: 'm-1' } }
        );
        expect(result.fd).toEqual({
            pathParams: {},
            actionId: 'nominee_register_2',
            deliveries: 5,
        });
    });

    it('userInputs: the scenario’s inputs reach the draft, under the step’s own', async () => {
        const { txn } = await generate(
            { userInputs: { requote: true, a: 1 } },
            { context: { message_id: 'm-1' } },
            { a: 2 }
        );
        expect(txn.draft).toHaveBeenCalledWith(
            expect.objectContaining({ userInputs: { requote: true, a: 2 } })
        );
    });
});

describe('M6 scenarios in the SEND job: deliveries and receipts', () => {
    const ackOf = (status = 'ACK') => ({
        context: { transaction_id: TXN_ID, message_id: 'm-db-1' },
        message: { ack: { status } },
    });
    const payload = {
        context: { transaction_id: TXN_ID, message_id: 'm-db-1' },
        message: { deposit: {} },
    };
    const send = (
        deps: Parameters<typeof createApiServiceRequestJobHandler>[0],
        fd: object
    ) =>
        createApiServiceRequestJobHandler(deps)({
            action: 'on_deposit_booked',
            domain: FD,
            version: FD_VERSION,
            payload,
            subscriberUrl: NP_URL,
            fd: { pathParams: {}, ...fd },
        });

    it('delivers the same text five times at once and judges every receipt', async () => {
        const { workbenchCache } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 200, data: ackOf(), headers: {} });
        const queue = queueSpy();
        await send({ workbenchCache, queue }, { deliveries: 5 });

        expect(post).toHaveBeenCalledTimes(5);
        const bodies = new Set(post.mock.calls.map(c => c[1]));
        expect(bodies).toEqual(new Set([JSON.stringify(payload)]));
        // The first delivery was recorded at the draft; four more are re-sends.
        expect(txn.sent).toHaveBeenCalledTimes(4);
        expect(txn.sent).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'on_deposit_booked',
                replay: true,
            })
        );
        expect(txn.observe).toHaveBeenCalledTimes(5);
        expect(txn.observe).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'on_deposit_booked',
                body: ackOf(),
                httpStatus: 200,
            })
        );
        expect(txn.calls.slice(-1)).toEqual(['save']);
        expect(mockedAdvance).toHaveBeenCalledTimes(1);
    });

    it("a refusal by the workbench's own edge is not judged as the NP's answer", async () => {
        const { workbenchCache } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        jest.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: ackOf('NACK'),
            headers: { 'x-pwb-fd-gate-error': 'FD-PWB-0040' },
        });
        await send({ workbenchCache, queue: queueSpy() }, {});
        expect(txn.observe).not.toHaveBeenCalled();
        expect(txn.calls).toEqual(['save']);
    });

    it('a re-send (retry step) carries X-Pwb-Fd-Replay, sends the stored text, is judged and moves the flow on', async () => {
        const { workbenchCache } = await seedFd('BAP');
        const txn = fakeFdTxn();
        mockedOpen.mockResolvedValue(txn);
        const original = '{"context":{"transaction_id":"x"}}';
        const post = jest
            .spyOn(axios, 'post')
            .mockResolvedValue({ status: 202, data: ackOf(), headers: {} });
        await send(
            { workbenchCache, queue: queueSpy() },
            { resend: true, rawBody: original }
        );
        expect(post.mock.calls[0][1]).toBe(original);
        expect(post.mock.calls[0][2]?.headers).toMatchObject({
            'X-Pwb-Fd-Replay': '1',
        });
        expect(txn.observe).toHaveBeenCalledTimes(1);
        expect(mockedAdvance).toHaveBeenCalledTimes(1);
    });
});
