import { computeSubscriber } from './flow-utils';
import { BecknContext } from '../types/ondc-types';

const BUYER = 'http://workbench.localhost/api-service/ONDC:NTS10/2.1.0/buyer';
const SELLER = 'http://workbench.localhost/api-service/ONDC:NTS10/2.1.0/seller';

const ctx = (
    action: string,
    extra: Partial<BecknContext> = {}
): BecknContext => ({
    domain: 'ONDC:NTS10',
    action,
    transaction_id: 'txn-1',
    bap_uri: BUYER,
    bpp_uri: SELLER,
    ...extra,
});

describe('computeSubscriber', () => {
    describe('without a subscriber_url (the beckn convention)', () => {
        it('takes bap_uri for search', () => {
            expect(
                computeSubscriber(ctx('search', { bpp_uri: undefined }))
            ).toBe(BUYER);
        });

        it('takes bpp_uri for a callback', () => {
            expect(computeSubscriber(ctx('on_select'))).toBe(SELLER);
        });

        it('takes bap_uri for a request', () => {
            expect(computeSubscriber(ctx('recon'))).toBe(BUYER);
        });

        it('throws for a callback without bpp_uri', () => {
            expect(() =>
                computeSubscriber(ctx('on_select', { bpp_uri: undefined }))
            ).toThrow('BPP URI is not present');
        });
    });

    describe('with the subscriber_url the api-service resolved', () => {
        it('takes bpp_uri for a request the seller sends (RSF recon)', () => {
            expect(computeSubscriber(ctx('recon'), SELLER)).toBe(SELLER);
        });

        it('takes bap_uri for a callback the buyer sends (RSF on_recon)', () => {
            expect(computeSubscriber(ctx('on_recon'), BUYER)).toBe(BUYER);
        });

        it('agrees with the convention when the convention is right', () => {
            expect(computeSubscriber(ctx('on_select'), SELLER)).toBe(SELLER);
            expect(computeSubscriber(ctx('select'), BUYER)).toBe(BUYER);
        });

        it('ignores a trailing slash and returns the uri as the context has it', () => {
            expect(computeSubscriber(ctx('recon'), `${SELLER}/`)).toBe(SELLER);
        });

        it('falls back to the convention for a url matching neither side', () => {
            expect(
                computeSubscriber(ctx('recon'), 'https://elsewhere.example')
            ).toBe(BUYER);
        });

        it('falls back to the convention for a missing or non-string value', () => {
            expect(computeSubscriber(ctx('recon'), '')).toBe(BUYER);
            expect(computeSubscriber(ctx('recon'), [SELLER, BUYER])).toBe(
                BUYER
            );
            expect(computeSubscriber(ctx('on_recon'), undefined)).toBe(SELLER);
        });
    });
});
