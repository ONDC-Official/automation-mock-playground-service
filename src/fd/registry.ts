/**
 * Registry key lookups for the FD engine. When the workbench plays the investor app, it must
 * verify the issuer's quote signature against the issuer's key in the ONDC Registry; without a
 * lookup every quote is a finding.
 *
 * `FD_REGISTRY_URL` names the Registry (`<url>lookup`, as the API service's key manager calls
 * it). When the workbench's identity is configured (`FD_SUBSCRIBER_ID`, `FD_UNIQUE_KEY_ID`,
 * `FD_SIGNING_PRIVATE_KEY`), the lookup is signed the ONDC way, as the Registry requires.
 * Keys are cached for 10 minutes; a failed lookup is not cached.
 */
import axios from 'axios';
import crypto from 'node:crypto';

export type KeyLookup = (
    subscriberId: string,
    uniqueKeyId: string
) => Promise<string>;

const CACHE_MS = 10 * 60 * 1000;

/** Base64 Ed25519 seed (32 bytes, or a 64-byte secret key whose first half is the seed). */
function privateKeyFromSeed(seedBase64: string): crypto.KeyObject {
    const seed = Buffer.from(seedBase64, 'base64').subarray(0, 32);
    const pkcs8 = Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
    ]);
    return crypto.createPrivateKey({
        key: pkcs8,
        format: 'der',
        type: 'pkcs8',
    });
}

/** An ONDC `Authorization: Signature …` header over a lookup body. */
export function signedLookupHeader(
    body: string,
    identity: { subscriberId: string; uniqueKeyId: string; privateKey: string },
    now = Math.floor(Date.now() / 1000)
): string {
    const digest = crypto
        .createHash('blake2b512')
        .update(body)
        .digest('base64');
    const created = now;
    const expires = now + 300;
    const signing = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
    const signature = crypto
        .sign(
            null,
            Buffer.from(signing),
            privateKeyFromSeed(identity.privateKey)
        )
        .toString('base64');
    return `Signature keyId="${identity.subscriberId}|${identity.uniqueKeyId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`;
}

/** The engine's keyLookup, or undefined when no Registry is configured. */
export function fdRegistryKeyLookup(
    env: NodeJS.ProcessEnv = process.env
): KeyLookup | undefined {
    const base = env.FD_REGISTRY_URL?.trim();
    if (!base) return undefined;
    const url = base.endsWith('/') ? `${base}lookup` : `${base}/lookup`;
    const identity =
        env.FD_SUBSCRIBER_ID &&
        env.FD_UNIQUE_KEY_ID &&
        env.FD_SIGNING_PRIVATE_KEY
            ? {
                  subscriberId: env.FD_SUBSCRIBER_ID,
                  uniqueKeyId: env.FD_UNIQUE_KEY_ID,
                  privateKey: env.FD_SIGNING_PRIVATE_KEY,
              }
            : undefined;
    const cache = new Map<string, { key: string; at: number }>();
    return async (subscriberId, uniqueKeyId) => {
        const cacheKey = `${subscriberId}|${uniqueKeyId}`;
        const hit = cache.get(cacheKey);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
        const body = JSON.stringify({
            subscriber_id: subscriberId,
            ukId: uniqueKeyId,
        });
        const res = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json',
                ...(identity && {
                    Authorization: signedLookupHeader(body, identity),
                }),
            },
            timeout: 5000,
        });
        const entries: unknown[] = Array.isArray(res.data) ? res.data : [];
        const key = (entries[0] as { signing_public_key?: unknown })
            ?.signing_public_key;
        if (typeof key !== 'string' || key === '') {
            throw new Error(
                `the Registry has no signing key for ${subscriberId} / ${uniqueKeyId}`
            );
        }
        cache.set(cacheKey, { key, at: Date.now() });
        return key;
    };
}
