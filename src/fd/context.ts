/**
 * Small FD helpers shared by the incoming, outgoing and replay paths.
 */
import { Request } from 'express';
import { SessionCache } from '../types/cache-types';
import { FlowContext } from '../types/process-flow-types';
import { MockRunnerConfig } from '../types/mock-runner-types';
import logger from '../utils/logger';
import { FD_HEADERS, FD_SCENARIO_KEY } from './constants';
import { FdFinding, FdInbound, FdScenario, FdTransactionKey } from './engine';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** The engine-state key of the transaction a flow context belongs to. */
export function fdKeyFromFlowContext(ctx: FlowContext): FdTransactionKey {
    return fdKeyFromSession(
        ctx.apiSessionCache,
        ctx.transactionId,
        ctx.subscriberUrl,
        ctx.domain,
        ctx.version
    );
}

export function fdKeyFromSession(
    session: SessionCache,
    transactionId: string,
    subscriberUrl: string,
    domain = session.domain,
    version = session.version
): FdTransactionKey {
    const counterparty: FdTransactionKey['counterparty'] = {
        subscriberUri: session.subscriberUrl,
    };
    if (session.subscriberId) counterparty.subscriberId = session.subscriberId;
    return {
        domain,
        version,
        transactionId,
        subscriberUrl,
        npType: session.npType,
        counterparty,
    };
}

/** Parses `X-Pwb-Fd-Path-Params` (a JSON object of strings); undefined when absent or bad. */
export function parsePathParamsHeader(
    raw: string | undefined
): Record<string, string> | undefined {
    if (!raw) return undefined;
    try {
        const value = JSON.parse(raw);
        if (!isRecord(value)) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch {
        return undefined;
    }
}

/**
 * The engine's view of a message an NP sent to the workbench, as fd-gate forwarded it: the
 * internal POST body, plus the REST method and path parameters from the `X-Pwb-*` headers.
 */
export function inboundFromRequest(req: Request, action: string): FdInbound {
    const body = req.body as Record<string, unknown> | undefined;
    const inbound: FdInbound = {
        body,
        action,
        method: (req.get(FD_HEADERS.method) || 'POST').toUpperCase(),
        receivedAt: new Date().toISOString(),
    };
    const pathParams = parsePathParamsHeader(req.get(FD_HEADERS.pathParams));
    if (pathParams) inbound.pathParams = pathParams;
    // A GET's internal frame carries the query in message.query (M2-DESIGN §3 np step 7).
    const message = isRecord(body?.message) ? body.message : undefined;
    if (isRecord(message?.query)) {
        inbound.query = message.query as Record<string, string>;
    }
    return inbound;
}

/** `context.message_id` of a protocol body, when it has one. */
export function messageIdOf(body: unknown): string | undefined {
    if (!isRecord(body) || !isRecord(body.context)) return undefined;
    const id = body.context.message_id;
    return typeof id === 'string' ? id : undefined;
}

/** `context.action` of a protocol body, when it has one. */
export function actionOf(body: unknown): string | undefined {
    if (!isRecord(body) || !isRecord(body.context)) return undefined;
    const action = body.context.action;
    return typeof action === 'string' ? action : undefined;
}

/** Logs the engine's findings on a message. The engine keeps them in its state too. */
export function logFdFindings(
    findings: FdFinding[],
    meta: Record<string, unknown>
): void {
    if (findings.length === 0) {
        logger.info('FD engine: no findings', meta);
        return;
    }
    logger.warning(`FD engine: ${findings.length} finding(s)`, {
        ...meta,
        findings: findings.map(f => ({
            rule: f.rule,
            errorCode: f.errorCode,
            fieldPath: f.fieldPath,
            detail: f.detail,
            requirementIds: f.requirementIds,
        })),
    });
}

/**
 * A step's negative-scenario directives (D-4): `mock.defaultPayload.fdScenario` in the
 * runner config, looked up across main and extra steps.
 */
export function fdScenarioOf(
    config: MockRunnerConfig,
    actionId: string
): FdScenario | undefined {
    const step =
        config.steps?.find(s => s.action_id === actionId) ??
        config.extra_steps?.steps.find(s => s.action_id === actionId);
    const defaultPayload = step?.mock?.defaultPayload as unknown;
    if (!isRecord(defaultPayload)) return undefined;
    const scenario = defaultPayload[FD_SCENARIO_KEY];
    return isRecord(scenario) ? (scenario as FdScenario) : undefined;
}

/** Removes `fdScenario` from a generated body: it steers the engine and is never sent. */
export function stripFdScenario<T>(payload: T): T {
    if (!isRecord(payload) || !(FD_SCENARIO_KEY in payload)) return payload;
    const copy: Record<string, unknown> = { ...payload };
    delete copy[FD_SCENARIO_KEY];
    return copy as T;
}
