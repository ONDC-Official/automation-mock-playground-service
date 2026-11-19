import { createCache } from '../../cache/cache-factory';
import { newMockRunnerConfigCache } from './config-cache';

const configFor = (domain: string, version: string) => ({
    meta: { domain, version, flowId: 'f1' },
    transaction_data: {
        transaction_id: 't',
        latest_timestamp: '',
    },
    steps: [],
});

async function resolvedUris(domain: string, version: string) {
    const cache1 = createCache('mock');
    const cache0 = createCache('mock');
    await cache1.set(
        `${domain}::${version}::f1::u1`,
        configFor(domain, version),
        {} as never
    );
    const config = await newMockRunnerConfigCache(
        cache1,
        cache0
    ).getMockRunnerConfig(domain, version, 'f1', 'u1');
    return config.transaction_data;
}

describe('getMockRunnerConfig workbench URIs', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.API_SERVICE_URL = 'http://api-service.local/api';
        delete process.env.FD_SUBSCRIBER_URL_BASE;
        delete process.env.FD_SUBSCRIBER_ID;
    });
    afterAll(() => {
        process.env = saved;
    });

    it('FD: …/investor-app and …/issuer', async () => {
        const td = await resolvedUris('ONDC:FIS14:FD', '0.1.4');
        expect(td.bap_uri).toBe(
            'http://api-service.local/api/ONDC:FIS14:FD/0.1.4/investor-app'
        );
        expect(td.bpp_uri).toBe(
            'http://api-service.local/api/ONDC:FIS14:FD/0.1.4/issuer'
        );
        expect(td.bap_id).toBe('api-service.local');
    });

    it('FD: FD_SUBSCRIBER_URL_BASE and FD_SUBSCRIBER_ID override the defaults', async () => {
        process.env.FD_SUBSCRIBER_URL_BASE = 'https://wb.ondc.org/fd';
        process.env.FD_SUBSCRIBER_ID = 'wb.ondc.org';
        const td = await resolvedUris('ONDC:FIS14:FD', '0.1.4');
        expect(td.bap_uri).toBe('https://wb.ondc.org/fd/investor-app');
        expect(td.bpp_uri).toBe('https://wb.ondc.org/fd/issuer');
        expect(td.bpp_id).toBe('wb.ondc.org');
    });

    it('Beckn: buyer/ and seller/ as before', async () => {
        process.env.FD_SUBSCRIBER_URL_BASE = 'https://wb.ondc.org/fd';
        const td = await resolvedUris('ONDC:RET10', '1.2.5');
        expect(td.bap_uri).toBe(
            'http://api-service.local/api/ONDC:RET10/1.2.5/buyer'
        );
        expect(td.bpp_uri).toBe(
            'http://api-service.local/api/ONDC:RET10/1.2.5/seller'
        );
        expect(td.bap_id).toBe('api-service.local');
    });
});
