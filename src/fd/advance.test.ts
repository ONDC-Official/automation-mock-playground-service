import { advanceAfterSyncExchange } from './advance';
import { actOnFlowService } from '../service/flows/process-flow';
import { IQueueService } from '../queue/IQueueService';
import { FLOW_ID, NP_URL, seedFd, TXN_ID } from '../test/fd-fixtures';

jest.mock('../service/flows/process-flow', () => ({
    actOnFlowService: jest.fn(async () => ({ success: true })),
}));
const mockedAct = actOnFlowService as jest.MockedFunction<
    typeof actOnFlowService
>;

const queue = {} as IQueueService;
const target = {
    transactionId: TXN_ID,
    subscriberUrl: NP_URL,
    messageId: 'm-req-1',
};
const fast = { intervalMs: 5, graceMs: 0, timeoutMs: 500 };

describe('advanceAfterSyncExchange', () => {
    it('waits for the API service to record the exchange, then dispatches the flow once', async () => {
        const { cache0, workbenchCache } = await seedFd('BAP');
        const pending = advanceAfterSyncExchange(
            { workbenchCache, queue },
            target,
            fast
        );
        await new Promise(r => setTimeout(r, 20));
        expect(mockedAct).not.toHaveBeenCalled();
        // The recorder appends the exchange.
        await cache0.set(
            `${TXN_ID}::${NP_URL}`,
            {
                sessionId: 'session-fd-1',
                flowId: FLOW_ID,
                latestAction: 'quote_request',
                latestTimestamp: '',
                subscriberType: 'BAP',
                messageIds: ['m-req-1'],
                apiList: [
                    {
                        entryType: 'API',
                        action: 'quote_request',
                        payloadId: 'p1',
                        messageId: 'm-req-1',
                        response: { context: {}, message: {} },
                        timestamp: '2026-10-29T10:00:00.000Z',
                    },
                ],
            },
            {} as never
        );
        await expect(pending).resolves.toBe(true);
        expect(mockedAct).toHaveBeenCalledTimes(1);
        const [ctx] = mockedAct.mock.calls[0];
        expect(ctx.transactionData.apiList).toHaveLength(1);
        expect(ctx.flowId).toBe(FLOW_ID);
    });

    it('gives up after the timeout without dispatching', async () => {
        const { workbenchCache } = await seedFd('BAP');
        await expect(
            advanceAfterSyncExchange({ workbenchCache, queue }, target, {
                ...fast,
                timeoutMs: 30,
            })
        ).resolves.toBe(false);
        expect(mockedAct).not.toHaveBeenCalled();
    });
});
