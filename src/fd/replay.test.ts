import { AddressInfo } from 'net';
import { Server } from 'http';
import ServiceContainer from '../container/container';
import { createCache } from '../cache/cache-factory';
import { IQueueService } from '../queue/IQueueService';
import { SEND_TO_API_SERVICE_JOB } from '../service/jobs/api-service-request';
import { openFdTransaction } from './engine';
import {
    fakeFdTxn,
    FakeFdTxn,
    fdSession,
    FD,
    FD_VERSION,
    FLOW_ID,
    NP_URL,
    SESSION_ID,
    TXN_ID,
} from './test-fixtures';

jest.mock('./engine', () => ({
    ...jest.requireActual('./engine'),
    openFdTransaction: jest.fn(),
}));
const mockedOpen = openFdTransaction as jest.MockedFunction<
    typeof openFdTransaction
>;

const queue: IQueueService & { enqueue: jest.Mock } = {
    process: jest.fn(),
    enqueue: jest.fn(async () => 'job-replay-1'),
    on: jest.fn(),
    close: jest.fn(),
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
    const container = ServiceContainer.getInstance();
    container.reset();
    const cache0 = createCache('mock');
    container.setCacheService0(cache0);
    container.setCacheService1(createCache('mock'));
    container.setQueueService(queue);
    await cache0.set(SESSION_ID, fdSession('BAP'), {} as never);
    await cache0.set(
        `${TXN_ID}::${NP_URL}`,
        {
            sessionId: SESSION_ID,
            flowId: FLOW_ID,
            latestAction: '',
            latestTimestamp: '',
            subscriberType: 'BAP',
            messageIds: [],
            apiList: [],
        },
        {} as never
    );
    // Routes read the container when they load, so the app is built after it is set up.
    const createServer = (await import('../server')).default;
    server = createServer().listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(done => {
    server.close(() => done());
});

const replayBody = {
    domain: FD,
    version: FD_VERSION,
    action: 'application_create',
    message_id: 'm-req-1',
    transaction_id: TXN_ID,
    subscriber_url: NP_URL,
};

const stored = {
    action: 'on_application_create',
    body: {
        context: { action: 'on_application_create', message_id: 'm-cb-1' },
    },
    pathParams: {},
};

const post = (path: string, body: unknown) =>
    globalThis.fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

describe('POST …/fd/replay', () => {
    it.each([
        '/mock/playground/fd/replay',
        `/mock/${FD}/${FD_VERSION}/fd/replay`,
    ])(
        '%s re-sends the stored callback unchanged, flagged as a replay',
        async path => {
            const txn: FakeFdTxn = fakeFdTxn({ stored });
            mockedOpen.mockResolvedValue(txn);

            const res = await post(path, replayBody);

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                replayed: true,
                action: 'on_application_create',
                jobId: 'job-replay-1',
            });
            expect(txn.replayFor).toHaveBeenCalledWith('m-req-1');
            expect(queue.enqueue).toHaveBeenCalledWith(
                SEND_TO_API_SERVICE_JOB,
                {
                    action: 'on_application_create',
                    domain: FD,
                    version: FD_VERSION,
                    payload: stored.body,
                    subscriberUrl: NP_URL,
                    queryParams: {
                        subscriber_url: NP_URL,
                        flow_id: FLOW_ID,
                        session_id: SESSION_ID,
                    },
                    fd: { pathParams: {}, replay: true },
                }
            );
            // Recorded in the engine state as a replay, for the report.
            expect(txn.sent).toHaveBeenCalledWith({
                action: 'on_application_create',
                body: stored.body,
                pathParams: {},
                answering: 'm-req-1',
                replay: true,
            });
            expect(txn.save).toHaveBeenCalled();
        }
    );

    it('answers 200 with replayed=false when nothing was sent for the request', async () => {
        mockedOpen.mockResolvedValue(fakeFdTxn());
        const res = await post('/mock/playground/fd/replay', replayBody);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ replayed: false });
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a non-FD domain or a missing field with 400', async () => {
        const res = await post('/mock/playground/fd/replay', {
            ...replayBody,
            domain: 'ONDC:RET10',
            message_id: undefined,
        });
        expect(res.status).toBe(400);
        expect(mockedOpen).not.toHaveBeenCalled();
    });
});
