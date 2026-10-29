/**
 * Messages the workbench sends in an FD flow (the GENERATE and SEND jobs).
 *
 * GENERATE: `prepareFdOutgoing` asks the engine for a draft, which the job puts in session data
 * as `fd_draft`; the step's generate script returns it, possibly tweaked
 * (`return sessionData.fd_draft || defaultPayload`); `finaliseFdOutgoing` drops `fdScenario`,
 * records the final body with `engine.sent` and saves the state.
 *
 * SEND: `fdSendHeaders` adds the internal `X-Pwb-*` headers for the API service's FD module.
 *
 * Scenario directives (the step's `fdScenario`, D-4) the playground itself acts on:
 * - `userInputs`: merged under the step's own inputs into the draft request;
 * - `retry`: the engine returns the earlier message; it is re-sent as its stored text, so the
 *   bytes are identical (`FD_SENT_RAW`), and the flow moves on as after any send;
 * - `deliveries: n`: the send job delivers the same text n times concurrently.
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
    FdScenario,
    FdTransaction,
    FdTransactionKey,
    getFdRoute,
    openFdTransaction,
} from './engine';

/** FD metadata the SEND job carries (JSON: it may cross RabbitMQ). */
export interface FdSendMeta {
    /** `X-Pwb-Fd-Path-Params`: the REST path parameters from the draft. */
    pathParams: Record<string, string>;
    /** Re-send of a stored message for `/fd/replay` (`X-Pwb-Fd-Replay: 1`); not a flow step. */
    replay?: boolean;
    /**
     * A flow step that re-sends an earlier message (scenario `retry`): the stored text, with
     * `X-Pwb-Fd-Replay: 1`; unlike `replay` it is judged and moves the flow on.
     */
    resend?: boolean;
    /** Deliver the same text this many times concurrently (scenario `deliveries`). */
    deliveries?: number;
    /** The flow step this send is for (the advance guards against re-sending it in a loop). */
    actionId?: string;
    /** A replay's exact original text, sent unchanged so the body digest matches. */
    rawBody?: string;
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
    scenario?: FdScenario;
    workbenchCache: WorkbenchCacheServiceType;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

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
    const scenario = fdScenarioOf(runnerConfig, actionMeta.actionId);
    const txn = await openFdTransaction(
        workbenchCache,
        fdKeyFromFlowContext(flowContext)
    );
    try {
        const draft = await txn.draft({
            action: route.action,
            answering,
            scenario,
            userInputs: mergeInputs(scenario?.userInputs, params.inputs),
        });
        return { txn, route, draft, answering, scenario, workbenchCache };
    } catch (e) {
        await txn.release();
        throw e;
    }
}

/** The step's own inputs win over the scenario's `userInputs`. */
function mergeInputs(fromScenario: unknown, inputs: unknown): unknown {
    if (!isRecord(fromScenario)) return inputs;
    return { ...fromScenario, ...(isRecord(inputs) ? inputs : {}) };
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
    const resend =
        out.scenario?.retry !== undefined && out.scenario.retry !== false;
    out.txn.sent({
        action: out.route.action,
        body: payload,
        pathParams: out.draft.pathParams,
        answering: out.answering ? messageIdOf(out.answering.body) : undefined,
        ...(resend && { replay: true }),
    });
    await out.txn.save();

    const fd: FdSendMeta = {
        pathParams: out.draft.pathParams,
        actionId: actionMeta.actionId,
    };
    if (resend) {
        // The engine keeps bodies as canonical JSON; the original text makes the repeat
        // byte-identical, as a retry must be.
        fd.resend = true;
        const messageId = messageIdOf(payload);
        const raw = messageId
            ? await out.workbenchCache
                  .FdCacheService()
                  .getSentRaw(
                      flowContext.transactionId,
                      flowContext.subscriberUrl,
                      messageId
                  )
            : null;
        if (raw !== null) fd.rawBody = raw;
        else {
            logger.warning(
                'FD retry: the original text is not kept; re-sending the stored body, which may not be byte-identical',
                { transactionId: flowContext.transactionId, messageId }
            );
        }
    }
    const deliveries = out.scenario?.deliveries;
    if (typeof deliveries === 'number' && deliveries > 1) {
        fd.deliveries = Math.min(Math.floor(deliveries), 20);
    }
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
        if (fd.replay || fd.resend) headers[FD_HEADERS.replay] = '1';
    }
    return headers;
}
