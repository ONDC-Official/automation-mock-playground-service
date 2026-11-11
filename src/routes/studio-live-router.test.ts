import express from 'express';
import type { AddressInfo } from 'net';
import { GraphExecutorV2 } from '@ondc/automation-mock-runner';

import { createCache } from '../cache/cache-factory';
import { SessionCacheSchema } from '../types/cache-types';
import { WorkbenchCacheService } from '../service/cache/workbench-cache';
import {
    clearLiveExecutors,
    LiveDeps,
} from '../service/studio-live/live-session';
import { createStudioLiveRouter } from './studio-live-router';

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
const serve = async () => {
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
    app.use(createStudioLiveRouter(() => deps));
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
});
