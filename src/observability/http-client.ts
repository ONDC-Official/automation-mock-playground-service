import axios, {
    AxiosError,
    AxiosInstance,
    InternalAxiosRequestConfig,
} from 'axios';
import log from './log';
import { capBody, shouldLogBody } from './redact';
import { externalRequestsTotal, externalRequestDuration, lbl } from './metrics';

/**
 * Shared axios instance that logs every outbound call as an `egress` event
 * (carrying the request-scoped trace envelope) and records external-call
 * metrics. Errors are re-thrown unchanged so existing call-site `try/catch`
 * behaviour is preserved.
 *
 * `target` is inferred from the URL (api-service / config-service / external),
 * or set explicitly via `obsTarget` on the request config.
 */

interface ObsMeta {
    start: number;
    target: string;
    reqBody?: Record<string, unknown>;
}

interface ObsConfig extends InternalAxiosRequestConfig {
    obsTarget?: string;
    obsMeta?: ObsMeta;
}

function classifyTarget(url?: string, explicit?: string): string {
    if (explicit) return explicit;
    if (!url) return 'external';
    const api = process.env.API_SERVICE_URL;
    const cfg = process.env.CONFIG_SERVICE_URL;
    if (api && url.startsWith(api)) return 'api-service';
    if (cfg && url.startsWith(cfg)) return 'config-service';
    return 'external';
}

export const obsAxios: AxiosInstance = axios.create();

obsAxios.interceptors.request.use(config => {
    const cfg = config as ObsConfig;
    const target = classifyTarget(cfg.url, cfg.obsTarget);
    cfg.obsMeta = {
        start: Date.now(),
        target,
        reqBody: shouldLogBody('egress') ? capBody(cfg.data) : undefined,
    };
    return cfg;
});

function emitEgress(
    cfg: ObsConfig | undefined,
    method: string | undefined,
    url: string | undefined,
    status: number | undefined,
    responseData: unknown,
    errored: boolean
): void {
    const meta = cfg?.obsMeta;
    const target = meta?.target ?? classifyTarget(url, cfg?.obsTarget);
    const statusLabel = lbl(status);
    const durationMs = meta ? Date.now() - meta.start : 0;

    externalRequestsTotal.inc({ target, status: statusLabel });
    externalRequestDuration.observe(
        { target, status: statusLabel },
        durationMs / 1000
    );

    const line: Record<string, unknown> = {
        event: 'egress',
        component: 'egress',
        target,
        http: { method, url, status, duration_ms: durationMs },
    };
    if (meta?.reqBody) line.request = meta.reqBody;
    if (shouldLogBody('egress')) line.response = capBody(responseData);

    if (errored) {
        log.error('egress', line);
    } else {
        log.info('egress', line);
    }
}

obsAxios.interceptors.response.use(
    response => {
        emitEgress(
            response.config as ObsConfig,
            response.config.method,
            response.config.url,
            response.status,
            response.data,
            false
        );
        return response;
    },
    (error: AxiosError) => {
        emitEgress(
            error.config as ObsConfig | undefined,
            error.config?.method,
            error.config?.url,
            error.response?.status,
            error.response?.data,
            true
        );
        return Promise.reject(error);
    }
);

export default obsAxios;
