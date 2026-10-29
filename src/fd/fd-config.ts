/**
 * Where the FD engine's inputs come from.
 *
 * - Route table: the config service serves it per build at
 *   `GET {CONFIG_SERVICE_URL}/api-service/fdRoutes?domain=&version=` → `{data: <table>}`
 *   (automation-db keeps it in the build meta as `fdRoutes`). It is fetched on first use and
 *   kept in memory. Env `FD_ROUTE_TABLE` (a path to fd_routes.yaml, which the API service build
 *   writes to `build-output/temp/config/fd_routes.yaml`) overrides it, for local runs.
 * - Spec: env `FD_SPEC`, a path to the FD OpenAPI YAML. The config service doesn't serve the
 *   OpenAPI document today.
 * - Identity: the workbench's own subscriber, from env (see `fdIdentity`).
 */
import axios from 'axios';
import { readFile } from 'fs/promises';
import { InternalServerError } from '../errors/custom-errors';
import logger from '../utils/logger';

/** An InternalServerError, so a request that hits it gets a 500 naming the cause. */
export class FdConfigError extends InternalServerError {
    constructor(message: string) {
        super(`[FD] ${message}`);
        this.name = 'FdConfigError';
    }
}

/** The role the WORKBENCH plays in an FD transaction (M2-DESIGN §7). */
export type FdRole = 'DEPOSIT_ISSUER' | 'INVESTOR_APP';

/**
 * The NP under test is the session's `npType`. An investor app under test (BAP) means the
 * workbench plays the deposit issuer; an issuer under test (BPP) means it plays the app.
 */
export function fdRoleForNpType(npType: 'BAP' | 'BPP'): FdRole {
    return npType === 'BAP' ? 'DEPOSIT_ISSUER' : 'INVESTOR_APP';
}

export interface FdIdentity {
    subscriberId: string;
    subscriberUri: string;
    signingPrivateKey?: string;
    uniqueKeyId?: string;
}

function apiServiceUrl(): string {
    const url =
        process.env.API_SERVICE_URL ||
        'https://dev-automation.ondc.org/api-service';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function apiServiceHost(): string {
    return apiServiceUrl().split('//')[1]?.split('/')[0] ?? '';
}

/** The workbench's FD subscriber id: env `FD_SUBSCRIBER_ID`, else the API service host. */
export function fdWorkbenchSubscriberId(): string {
    return process.env.FD_SUBSCRIBER_ID || apiServiceHost();
}

/**
 * The base the workbench's FD modules hang off: env `FD_SUBSCRIBER_URL_BASE`, else
 * `<API_SERVICE_URL>/<domain>/<version>` as for every other domain.
 */
export function fdWorkbenchBaseUrl(domain: string, version: string): string {
    const base =
        process.env.FD_SUBSCRIBER_URL_BASE ||
        `${apiServiceUrl()}/${domain}/${version}`;
    return base.endsWith('/') ? base.slice(0, -1) : base;
}

/** The workbench's `bap_uri` (investor app) and `bpp_uri` (issuer) for FD. */
export function fdWorkbenchUris(domain: string, version: string) {
    const base = fdWorkbenchBaseUrl(domain, version);
    return { bapUri: `${base}/investor-app`, bppUri: `${base}/issuer` };
}

/**
 * The workbench's identity for the role it plays:
 * - `FD_SUBSCRIBER_ID` (default: the API service host, as Beckn flows use);
 * - `FD_SUBSCRIBER_URL_BASE` (default `<API_SERVICE_URL>/<domain>/<version>`), plus
 *   `/investor-app` or `/issuer`;
 * - `FD_SIGNING_PRIVATE_KEY`, `FD_UNIQUE_KEY_ID` (optional; the issuer role signs quotes).
 */
export function fdIdentity(
    role: FdRole,
    domain: string,
    version: string
): FdIdentity {
    const uris = fdWorkbenchUris(domain, version);
    const identity: FdIdentity = {
        subscriberId: fdWorkbenchSubscriberId(),
        subscriberUri: role === 'INVESTOR_APP' ? uris.bapUri : uris.bppUri,
    };
    if (process.env.FD_SIGNING_PRIVATE_KEY) {
        identity.signingPrivateKey = process.env.FD_SIGNING_PRIVATE_KEY;
    }
    if (process.env.FD_UNIQUE_KEY_ID) {
        identity.uniqueKeyId = process.env.FD_UNIQUE_KEY_ID;
    }
    return identity;
}

const ROUTE_TABLE_TTL_MS = 10 * 60 * 1000;
const routeTableCache = new Map<string, { value: unknown; at: number }>();
const routeTableInFlight = new Map<string, Promise<unknown>>();

/**
 * The FD route table for a build, as text (fd_routes.yaml, from `FD_ROUTE_TABLE`) or as the
 * table object (from the config service). The engine accepts either.
 */
export async function fetchFdRouteTableSource(
    domain: string,
    version: string
): Promise<unknown> {
    const override = process.env.FD_ROUTE_TABLE;
    const key = override ? `file:${override}` : `${domain}::${version}`;
    const hit = routeTableCache.get(key);
    if (hit && Date.now() - hit.at < ROUTE_TABLE_TTL_MS) return hit.value;
    const pending = routeTableInFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
        let value: unknown;
        if (override) {
            try {
                value = await readFile(override, 'utf8');
            } catch (e) {
                throw new FdConfigError(
                    `cannot read the route table FD_ROUTE_TABLE=${override}: ${(e as Error).message}`
                );
            }
        } else {
            const base = process.env.CONFIG_SERVICE_URL;
            if (!base) {
                throw new FdConfigError(
                    'no route table source: set CONFIG_SERVICE_URL or FD_ROUTE_TABLE'
                );
            }
            try {
                const res = await axios.get(`${base}/api-service/fdRoutes`, {
                    params: { domain, version },
                });
                value = (res.data as { data?: unknown })?.data;
            } catch (e) {
                const status = axios.isAxiosError(e)
                    ? e.response?.status
                    : undefined;
                throw new FdConfigError(
                    `the config service has no route table for ${domain} ${version}` +
                        ` (GET ${base}/api-service/fdRoutes → ${status ?? (e as Error).message})`
                );
            }
            if (!value) {
                throw new FdConfigError(
                    `the config service returned an empty route table for ${domain} ${version}`
                );
            }
        }
        routeTableCache.set(key, { value, at: Date.now() });
        logger.info('FD route table loaded', {
            domain,
            version,
            source: override ? 'FD_ROUTE_TABLE' : 'config-service',
        });
        return value;
    })();
    routeTableInFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        routeTableInFlight.delete(key);
    }
}

let specText: Promise<string> | null = null;

/** The FD OpenAPI document as text, from env `FD_SPEC` (read once). */
export function readFdSpecSource(): Promise<string> {
    const path = process.env.FD_SPEC;
    if (!path) {
        return Promise.reject(
            new FdConfigError(
                'FD_SPEC is not set: point it at the FD OpenAPI YAML'
            )
        );
    }
    if (!specText) {
        specText = readFile(path, 'utf8').catch(e => {
            specText = null;
            throw new FdConfigError(
                `cannot read the FD spec FD_SPEC=${path}: ${(e as Error).message}`
            );
        });
    }
    return specText;
}

/** Test hook: forget cached route tables and spec. */
export function resetFdConfigCache(): void {
    routeTableCache.clear();
    routeTableInFlight.clear();
    specText = null;
}
