import express from 'express';
import type { AddressInfo } from 'net';
import MockRunner, {
    GraphExecutorV2,
    type LiveGraphConfigV2,
} from '@ondc/automation-mock-runner';

import { createCache } from '../cache/cache-factory';
import ServiceContainer from '../container/container';
import { IQueueService } from '../queue/IQueueService';
import { SessionCacheSchema } from '../types/cache-types';
import { WorkbenchCacheService } from '../service/cache/workbench-cache';
import {
    clearLiveExecutors,
    LiveDeps,
    liveConfigKey,
    STUDIO_LIVE_ADVANCE_JOB,
    STUDIO_LIVE_SEND_JOB,
} from '../service/studio-live/live-session';
import studioLiveRouter, { createStudioLiveRouter } from './studio-live-router';

const session = (sessionId: string, engine?: string) => ({
    transactionIds: [],
    flowMap: {},
    npType: 'BPP',
    domain: 'ONDC:TRV14',
    version: '2.0.0',
    subscriberUrl: 'https://np.example.com',
    usecaseId: 'PLAYGROUND-FLOW',
    env: 'LOGGED-IN',
    flowConfigs: {},
    ...(engine ? { engine } : {}),
    sessionId,
});

/** The live router in front of a stand-in for the v1 routers. */
const serve = async (router?: express.Router) => {
    clearLiveExecutors();
    const cache = createCache('mock');
    await cache.set('v1-session', session('v1-session'), SessionCacheSchema);
    await cache.set(
        'v2-session',
        session('v2-session', 'graph-v2'),
        SessionCacheSchema
    );
    const deps: LiveDeps = {
        cache,
        workbench: WorkbenchCacheService(cache),
        queue: {
            process: () => undefined,
            on: () => undefined,
            close: async () => undefined,
            enqueue: async () => 'job',
        },
    };
    const app = express();
    app.use(express.json());
    app.use(router ?? createStudioLiveRouter(() => deps));
    app.use((req, res) => res.status(299).json({ v1: req.path }));
    app.use(
        (
            error: Error,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction
        ) => res.status(500).json({ error: error.message })
    );
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
    };
    return { call, close: () => server.close() };
};

afterAll(() => GraphExecutorV2.terminateSharedRunner());

describe('studio live router', () => {
    it('hands v1 sessions and unknown transactions on to the v1 routers', async () => {
        const { call, close } = await serve();
        try {
            for (const [method, path, body] of [
                [
                    'POST',
                    '/flows/new',
                    { session_id: 'v1-session', flow_id: 'f' },
                ],
                [
                    'POST',
                    '/flows/proceed',
                    { session_id: 'v1-session', transaction_id: 't' },
                ],
                [
                    'GET',
                    '/flows/current-status?session_id=v1-session&transaction_id=t',
                ],
                [
                    'POST',
                    '/manual/on_search',
                    {
                        context: {
                            action: 'on_search',
                            transaction_id: 'unknown',
                            bap_uri: 'https://np.example.com',
                            bpp_uri: 'https://np.example.com',
                        },
                    },
                ],
            ] as const) {
                const res = await call(method, path, body);
                expect({ path, status: res.status }).toEqual({
                    path,
                    status: 299,
                });
            }
        } finally {
            close();
        }
    });

    it('answers graph-v2 sessions itself', async () => {
        const { call, close } = await serve();
        try {
            // No graph document stored: the live path handles it, and fails as an error.
            const res = await call('POST', '/flows/new', {
                session_id: 'v2-session',
                flow_id: 'happy',
            });
            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).toMatch(/No live graph document/);
        } finally {
            close();
        }
    });

    describe('the Studio queue', () => {
        type Recorded = {
            queue: IQueueService;
            processes: Map<string, (data: unknown) => Promise<unknown>>;
            jobs: { name: string; data: unknown }[];
        };
        const recordingQueue = (): Recorded => {
            const processes = new Map<
                string,
                (data: unknown) => Promise<unknown>
            >();
            const jobs: { name: string; data: unknown }[] = [];
            const queue: IQueueService = {
                process: (name, handler) => {
                    processes.set(
                        name,
                        handler as (data: unknown) => Promise<unknown>
                    );
                },
                on: () => undefined,
                close: async () => undefined,
                enqueue: async (name, data) => {
                    jobs.push({ name, data });
                    return `job-${jobs.length}`;
                },
            };
            return { queue, processes, jobs };
        };

        const container = ServiceContainer.getInstance();
        afterEach(() => container.reset());

        /** The container as main.ts wires it, on recording queues. */
        const wire = (withStudioQueue = true) => {
            container.reset();
            const cache = createCache('mock');
            container.setCacheService0(cache);
            container.setCacheService1(createCache('mock'));
            const main = recordingQueue();
            container.setQueueService(main.queue);
            const studio = recordingQueue();
            if (withStudioQueue) container.setStudioQueueService(studio.queue);
            return { main, studio };
        };

        it('falls back to the main queue until Studio has its own', () => {
            const { main } = wire(false);
            expect(container.getStudioQueueService()).toBe(main.queue);
            const studio = recordingQueue();
            container.setStudioQueueService(studio.queue);
            expect(container.getStudioQueueService()).toBe(studio.queue);
            expect(container.getQueueService()).toBe(main.queue);
            expect([...studio.processes.keys()]).toEqual([
                STUDIO_LIVE_ADVANCE_JOB,
                STUDIO_LIVE_SEND_JOB,
            ]);
        });

        it('puts Studio jobs, and the jobs they enqueue, on the Studio queue', async () => {
            const { main, studio } = wire();
            const generate = MockRunner.encodeBase64(
                'async function generate(defaultPayload, sessionData) { return defaultPayload; }'
            );
            const doc: LiveGraphConfigV2 = {
                kind: 'graph-v2-live',
                meta: {
                    domain: 'ONDC:TRV14',
                    version: '2.0.0',
                    playground_version: 'v2',
                },
                transaction_data: {
                    transaction_id: 'tx-config',
                    latest_timestamp: '2025-01-01T00:00:00.000Z',
                },
                graph: {
                    nodes: [
                        {
                            id: 'search',
                            api: 'search',
                            owner: 'BAP',
                            kind: 'request',
                            code: { generate },
                            defaultPayload: { context: {}, message: {} },
                        },
                    ],
                    edges: [],
                },
                journeys: [
                    {
                        id: 'happy',
                        entry: 'search',
                        choices: {},
                        expects: {},
                        onDemand: [],
                    },
                ],
            };
            // The router main.ts mounts, on the container's services.
            const { call, close } = await serve(studioLiveRouter);
            try {
                const cache = container.getCacheService0();
                await cache.set(
                    'v2-session',
                    session('v2-session', 'graph-v2'),
                    SessionCacheSchema
                );
                await cache.set(
                    liveConfigKey('v2-session'),
                    doc,
                    SessionCacheSchema
                );
                // The mock (BAP) opens the journey: starting it enqueues an advance.
                const res = await call('POST', '/flows/new', {
                    session_id: 'v2-session',
                    flow_id: 'happy',
                    transaction_id: 'tx-1',
                });
                expect(res.status).toBe(200);
                expect(studio.jobs.map(j => j.name)).toEqual([
                    STUDIO_LIVE_ADVANCE_JOB,
                ]);

                // The advance runs on the Studio queue and sends from it too.
                await studio.processes.get(STUDIO_LIVE_ADVANCE_JOB)!(
                    studio.jobs[0].data
                );
                expect(studio.jobs.map(j => j.name)).toEqual([
                    STUDIO_LIVE_ADVANCE_JOB,
                    STUDIO_LIVE_SEND_JOB,
                ]);
                expect(main.jobs).toEqual([]);
            } finally {
                close();
            }
        });
    });
});
