import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCache } from '../cache/cache-factory';
import { WorkbenchCacheService } from '../service/cache/workbench-cache';

// The package as it is before it is built: requiring it throws.
const mockFactoryCalls = { count: 0 };
jest.mock(
    '@ondc/fd-contract',
    () => {
        mockFactoryCalls.count++;
        throw new Error("Cannot find module '@ondc/fd-contract'");
    },
    { virtual: true }
);

import {
    FdEngineUnavailableError,
    getFdRoute,
    openFdTransaction,
} from './engine';

const dir = mkdtempSync(join(tmpdir(), 'fd-engine-missing-'));
process.env.FD_SPEC = join(dir, 'spec.yaml');
process.env.FD_ROUTE_TABLE = join(dir, 'fd_routes.yaml');
writeFileSync(process.env.FD_SPEC, 'openapi: 3.1.0\n');
writeFileSync(process.env.FD_ROUTE_TABLE, 'x-fd-routes: {}\n');

describe('FD engine adapter without the package', () => {
    it('loading the adapter does not load the package (Beckn never needs it)', () => {
        expect(mockFactoryCalls.count).toBe(0);
    });

    it('the first FD use fails with FdEngineUnavailableError naming the package', async () => {
        const route = getFdRoute('ONDC:FIS14:FD', '0.1.4', 'quote_request');
        await expect(route).rejects.toBeInstanceOf(FdEngineUnavailableError);
        await expect(route).rejects.toThrow(
            /@ondc\/fd-contract.*npm run build/
        );
        await expect(
            openFdTransaction(WorkbenchCacheService(createCache('mock')), {
                domain: 'ONDC:FIS14:FD',
                version: '0.1.4',
                transactionId: 't',
                subscriberUrl: 'u',
                npType: 'BAP',
            })
        ).rejects.toBeInstanceOf(FdEngineUnavailableError);
    });
});
