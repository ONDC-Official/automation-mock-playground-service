import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';
import { createCache } from '../cache/cache-factory';
import { WorkbenchCacheService } from '../service/cache/workbench-cache';
import {
    FdEngineUnavailableError,
    getFdRoute,
    openFdTransaction,
    resetFdEngineCache,
} from './engine';
import { resetFdConfigCache } from './fd-config';
import { InternalServerError } from '../errors/custom-errors';

// The engine package, as §7 describes it. The real one is built by another workstream.
const mockEngine = {
    initialState: jest.fn((txId: string) => ({ txId, seen: [] as string[] })),
    observe: jest.fn(
        async (state: { seen: string[] }, msg: { action: string }) => ({
            state: { ...state, seen: [...state.seen, msg.action] },
            findings: [{ rule: 'x', detail: 'y' }],
        })
    ),
    draft: jest.fn(async (state: unknown) => ({
        state,
        body: { context: { action: 'on_x' } },
        pathParams: { applicationId: 'A' },
    })),
    sent: jest.fn((state: unknown) => state),
    replayFor: jest.fn(),
};
const mockCreateEngine = jest.fn((_cfg: unknown) => mockEngine);
const mockFind = jest.fn((action: string) =>
    action === 'quote_request' ? { action, mode: 'SYNC' } : undefined
);
const mockLoadRouteTable = jest.fn((_input: unknown) => ({ find: mockFind }));
jest.mock(
    '@ondc/fd-contract',
    () => ({
        createEngine: (cfg: unknown) => mockCreateEngine(cfg),
        loadRouteTable: (input: unknown) => mockLoadRouteTable(input),
        serialiseFdState: (s: unknown) => JSON.stringify(s),
        deserialiseFdState: (t: string) => JSON.parse(t),
    }),
    { virtual: true }
);

const FD = 'ONDC:FIS14:FD';
const key = {
    domain: FD,
    version: '0.1.4',
    transactionId: 'txn-1',
    subscriberUrl: 'https://np.example.com',
    npType: 'BAP' as const,
    counterparty: {
        subscriberId: 'np.example.com',
        subscriberUri: 'https://np.example.com',
    },
};

const dir = mkdtempSync(join(tmpdir(), 'fd-engine-test-'));
const specPath = join(dir, 'spec.yaml');
const routesPath = join(dir, 'fd_routes.yaml');
writeFileSync(specPath, 'openapi: 3.1.0\n');
writeFileSync(routesPath, 'x-fd-routes: {}\n');

const ENV_KEYS = [
    'FD_SPEC',
    'FD_ROUTE_TABLE',
    'FD_SUBSCRIBER_ID',
    'FD_SUBSCRIBER_URL_BASE',
    'FD_SIGNING_PRIVATE_KEY',
    'FD_UNIQUE_KEY_ID',
    'CONFIG_SERVICE_URL',
];

beforeEach(() => {
    resetFdEngineCache();
    resetFdConfigCache();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.FD_SPEC = specPath;
    process.env.FD_ROUTE_TABLE = routesPath;
});

describe('FD engine adapter', () => {
    it('creates the engine from FD_SPEC, the route table and the env identity; NP=BAP → workbench is DEPOSIT_ISSUER', async () => {
        process.env.FD_SUBSCRIBER_ID = 'workbench.ondc.org';
        process.env.FD_SUBSCRIBER_URL_BASE = 'https://workbench.ondc.org/fd/';
        process.env.FD_SIGNING_PRIVATE_KEY = 'priv';
        process.env.FD_UNIQUE_KEY_ID = 'ukid-1';
        const cache = WorkbenchCacheService(createCache('mock'));
        const txn = await openFdTransaction(cache, key);
        expect(txn.role).toBe('DEPOSIT_ISSUER');
        expect(mockLoadRouteTable).toHaveBeenCalledWith('x-fd-routes: {}\n');
        expect(mockCreateEngine).toHaveBeenCalledWith({
            spec: 'openapi: 3.1.0\n',
            routes: { find: mockFind },
            identity: {
                subscriberId: 'workbench.ondc.org',
                subscriberUri: 'https://workbench.ondc.org/fd/issuer',
                signingPrivateKey: 'priv',
                uniqueKeyId: 'ukid-1',
            },
            role: 'DEPOSIT_ISSUER',
        });
    });

    it('NP=BPP → the workbench plays INVESTOR_APP at …/investor-app', async () => {
        process.env.API_SERVICE_URL = 'http://api-service.local';
        const cache = WorkbenchCacheService(createCache('mock'));
        const txn = await openFdTransaction(cache, { ...key, npType: 'BPP' });
        expect(txn.role).toBe('INVESTOR_APP');
        expect(mockCreateEngine).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'INVESTOR_APP',
                identity: {
                    subscriberId: 'api-service.local',
                    subscriberUri: `http://api-service.local/${FD}/0.1.4/investor-app`,
                },
            })
        );
    });

    it('starts a state, and persists it as FD_ENGINE_STATE::<txn>::<subscriberUrl> for 5 h', async () => {
        const cache0 = createCache('mock');
        const set = jest.spyOn(cache0, 'set');
        const cache = WorkbenchCacheService(cache0);
        const txn = await openFdTransaction(cache, key);
        expect(mockEngine.initialState).toHaveBeenCalledWith('txn-1');
        const obs = await txn.observe({
            body: {},
            action: 'application_create',
            method: 'POST',
        });
        expect(obs.findings).toEqual([{ rule: 'x', detail: 'y' }]);
        await txn.draft({ action: 'on_application_create' });
        expect(mockEngine.draft).toHaveBeenCalledWith(expect.anything(), {
            action: 'on_application_create',
            counterparty: key.counterparty,
        });
        await txn.save();
        expect(set).toHaveBeenCalledWith(
            'FD_ENGINE_STATE::txn-1::https://np.example.com',
            { txId: 'txn-1', seen: ['application_create'] },
            expect.anything(),
            5 * 60 * 60
        );

        // Reopening reads it back with deserialiseFdState.
        mockEngine.initialState.mockClear();
        const again = await openFdTransaction(cache, key);
        await again.observe({ body: {}, action: 'on_x', method: 'POST' });
        expect(mockEngine.initialState).not.toHaveBeenCalled();
        expect(mockEngine.observe).toHaveBeenLastCalledWith(
            { txId: 'txn-1', seen: ['application_create'] },
            expect.anything()
        );
    });

    it('reads the route table from the config service when FD_ROUTE_TABLE is unset', async () => {
        delete process.env.FD_ROUTE_TABLE;
        process.env.CONFIG_SERVICE_URL = 'http://config.local';
        const table = { formatVersion: 1, routes: [] };
        const get = jest
            .spyOn(axios, 'get')
            .mockResolvedValue({ data: { data: table } });
        const route = await getFdRoute(FD, '0.1.4', 'quote_request');
        expect(route).toEqual({ action: 'quote_request', mode: 'SYNC' });
        expect(get).toHaveBeenCalledWith(
            'http://config.local/api-service/fdRoutes',
            {
                params: { domain: FD, version: '0.1.4' },
            }
        );
        expect(mockLoadRouteTable).toHaveBeenCalledWith(table);
        // Cached: a second lookup doesn't refetch.
        await getFdRoute(FD, '0.1.4', 'deposit_read');
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('fails clearly when FD_SPEC is missing', async () => {
        delete process.env.FD_SPEC;
        await expect(
            openFdTransaction(WorkbenchCacheService(createCache('mock')), key)
        ).rejects.toThrow('FD_SPEC is not set');
    });
});

describe('FdEngineUnavailableError', () => {
    it('is an InternalServerError, so a request gets a 500 naming the cause', () => {
        const err = new FdEngineUnavailableError('x');
        expect(err).toBeInstanceOf(InternalServerError);
        expect(err.message).toContain('@ondc/fd-contract');
    });
});
