/**
 * Messages the workbench sends in an FD flow (the GENERATE and SEND jobs).
 *
 * GENERATE: `prepareFdOutgoing` asks the engine for a draft, which the job puts in session data
 * as `fd_draft`; the step's generate script returns it, possibly tweaked
 * (`return sessionData.fd_draft || defaultPayload`); `finaliseFdOutgoing` drops `fdScenario`,
 * records the final body with `engine.sent` and saves the state.
 *
 * SEND: `fdSendHeaders` adds the internal `X-Pwb-*` headers for the API service's FD module.
 */
import { WorkbenchCacheServiceType } from '../service/cache/workbench-cache';
import { MappedStep } from '../types/mapped-flow-types';
import { MockRunnerConfig } from '../types/mock-runner-types';
import { FlowContext } from '../types/process-flow-types';
import logger from '../utils/logger';
import { FD_HEADERS } from './constants';
import {
    fdKeyFromFlowContext,
    fdScenarioOf,
    messageIdOf,
    stripFdScenario,
} from './context';
import {
    FdDraft,
    FdInbound,
    FdRouteInfo,
    FdTransaction,
    FdTransactionKey,
    getFdRoute,
    openFdTransaction,
} from './engine';

/** FD metadata the SEND job carries (JSON: it may cross RabbitMQ). */
export interface FdSendMeta {
    /** `X-Pwb-Fd-Path-Params`: the REST path parameters from the draft. */
    pathParams: Record<string, string>;
    /** Re-send of a stored message (`X-Pwb-Fd-Replay: 1`). */
    replay?: boolean;
    /**
     * Set when the workbench calls an NP's SYNC action: the HTTP response is the NP's answer,
     * to be observed and saved as the step's result.
     */
    syncAnswer?: {
        key: FdTransactionKey;
        sessionId: string;
        actionId: string;
        method: 'GET' | 'POST';
        requestMessageId?: string;
    };
}

export interface FdOutgoing {
    txn: FdTransaction;
    route: FdRouteInfo;
    draft: FdDraft;
    answering?: FdInbound;
}

/** Drafts the workbench's next message for a flow step. Throws when FD can't run. */
export async function prepareFdOutgoing(params: {
    flowContext: FlowContext;
    actionMeta: MappedStep;
    inputs?: unknown;
    runnerConfig: MockRunnerConfig;
    workbenchCache: WorkbenchCacheServiceType;
}): Promise<FdOutgoing> {
    const { flowContext, actionMeta, runnerConfig, workbenchCache } = params;
    const route = await getFdRoute(
        flowContext.domain,
        flowContext.version,
        actionMeta.actionType
    );
    if (!route) {
        throw new Error(
            `[FD] action ${actionMeta.actionType} is not in the FD route table`
        );
    }
    let answering: FdInbound | undefined;
    if (route.kind === 'callback' && route.inReplyTo) {
        answering = (await workbenchCache
            .FdCacheService()
            .getInbound(
                flowContext.transactionId,
                flowContext.subscriberUrl,
                route.inReplyTo
            )) as FdInbound | undefined;
        if (!answering) {
            logger.warning(
                `FD: no ${route.inReplyTo} request on record to answer with ${route.action}`,
                { transactionId: flowContext.transactionId }
            );
        }
    }
    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(flowContext)
    );
    const draft = await txn.draft({
        action: route.action,
        answering,
        scenario: fdScenarioOf(runnerConfig, actionMeta.actionId),
        userInputs: params.inputs,
    });
    return { txn, route, draft, answering };
}

/**
 * After the step script: removes `fdScenario`, records what is actually sent, saves the state
 * and returns the payload with the SEND job's FD metadata.
 */
export async function finaliseFdOutgoing(
    out: FdOutgoing,
    generated: unknown,
    flowContext: FlowContext,
    actionMeta: MappedStep
): Promise<{ payload: unknown; fd: FdSendMeta }> {
    const payload = stripFdScenario(generated);
    out.txn.sent({
        action: out.route.action,
        body: payload,
        pathParams: out.draft.pathParams,
        answering: out.answering ? messageIdOf(out.answering.body) : undefined,
    });
    await out.txn.save();

    const fd: FdSendMeta = { pathParams: out.draft.pathParams };
    if (out.route.mode === 'SYNC' && out.route.kind === 'request') {
        fd.syncAnswer = {
            key: fdKeyFromFlowContext(flowContext),
            sessionId: flowContext.sessionId,
            actionId: actionMeta.actionId,
            method: out.route.method,
            requestMessageId: messageIdOf(payload),
        };
    }
    return { payload, fd };
}

/** The internal headers on a call to the API service's FD `mock/` route (M2-DESIGN §2). */
export function fdSendHeaders(fd?: FdSendMeta): Record<string, string> {
    const headers: Record<string, string> = {};
    const internalKey = process.env.PWB_INTERNAL_KEY;
    if (internalKey) headers[FD_HEADERS.internalKey] = internalKey;
    if (fd) {
        headers[FD_HEADERS.pathParams] = JSON.stringify(fd.pathParams ?? {});
        if (fd.replay) headers[FD_HEADERS.replay] = '1';
    }
    return headers;
}
