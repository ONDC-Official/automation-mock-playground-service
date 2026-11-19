import axios from 'axios';
import crypto from 'node:crypto';
import { fdRegistryKeyLookup, signedLookupHeader } from './registry';

afterEach(() => jest.restoreAllMocks());

describe('FD Registry key lookup', () => {
    it('is off without FD_REGISTRY_URL', () => {
        expect(fdRegistryKeyLookup({})).toBeUndefined();
    });

    it('looks up the signing key, caches it, and signs the lookup when the identity is set', async () => {
        const seed = crypto.randomBytes(32).toString('base64');
        const post = jest.spyOn(axios, 'post').mockResolvedValue({
            data: [
                {
                    subscriber_id: 'issuer.x',
                    ukId: 'k1',
                    signing_public_key: 'PUB',
                },
            ],
        });
        const lookup = fdRegistryKeyLookup({
            FD_REGISTRY_URL: 'http://registry:8090/',
            FD_SUBSCRIBER_ID: 'workbench.x',
            FD_UNIQUE_KEY_ID: 'wk1',
            FD_SIGNING_PRIVATE_KEY: seed,
        })!;
        await expect(lookup('issuer.x', 'k1')).resolves.toBe('PUB');
        await expect(lookup('issuer.x', 'k1')).resolves.toBe('PUB');
        expect(post).toHaveBeenCalledTimes(1);
        const [url, body, config] = post.mock.calls[0];
        expect(url).toBe('http://registry:8090/lookup');
        expect(JSON.parse(body as string)).toEqual({
            subscriber_id: 'issuer.x',
            ukId: 'k1',
        });
        expect(String(config?.headers?.Authorization)).toMatch(
            /^Signature keyId="workbench\.x\|wk1\|ed25519",algorithm="ed25519",created="\d+",expires="\d+",headers="\(created\) \(expires\) digest",signature="/
        );
    });

    it('fails, and does not cache, when the Registry has no key', async () => {
        const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: [] });
        const lookup = fdRegistryKeyLookup({
            FD_REGISTRY_URL: 'http://registry:8090',
        })!;
        await expect(lookup('nobody', 'k')).rejects.toThrow(/no signing key/);
        await expect(lookup('nobody', 'k')).rejects.toThrow(/no signing key/);
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[0][0]).toBe('http://registry:8090/lookup');
    });

    it('signs a lookup that verifies with the public key', () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const seed = privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .subarray(16)
            .toString('base64');
        const header = signedLookupHeader(
            '{"a":1}',
            { subscriberId: 's', uniqueKeyId: 'u', privateKey: seed },
            1000
        );
        const signature = /signature="([^"]+)"/.exec(header)![1];
        const digest = crypto
            .createHash('blake2b512')
            .update('{"a":1}')
            .digest('base64');
        const signing = `(created): 1000\n(expires): 1300\ndigest: BLAKE-512=${digest}`;
        expect(
            crypto.verify(
                null,
                Buffer.from(signing),
                publicKey,
                Buffer.from(signature, 'base64')
            )
        ).toBe(true);
    });
});
