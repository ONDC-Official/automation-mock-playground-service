/**
 * Fixtures for the FD (ONDC:FIS14:FD) tests: in-memory caches seeded with one transaction, a
 * fake engine transaction (the adapter is mocked in these tests) and a fake mock runner.
 */
import { Response } from 'express';
import { createCache } from '../cache/cache-factory';
import { ICacheService } from '../cache/cache-interface';
import {
    WorkbenchCacheService,
    WorkbenchCacheServiceType,
} from '../service/cache/workbench-cache';
import { HistoryType, SessionCache } from '../types/cache-types';
import { Flow, SequenceStep } from '../types/flow-types';
import { FlowContext } from '../types/process-flow-types';
import type { FdTransaction } from '../fd/engine';

export const FD = 'ONDC:FIS14:FD';
export const FD_VERSION = '0.1.4';
export const TXN_ID = 'txn-fd-1';
export const SESSION_ID = 'session-fd-1';
export const NP_URL = 'https://np.example.com/fd';
export const NP_ID = 'np.example.com';
export const FLOW_ID = 'fd_booking';

const step = (
    key: string,
    owner: 'BAP' | 'BPP',
    extra: Partial<SequenceStep> = {}
): SequenceStep => ({
    key,
    type: key,
    owner,
    unsolicited: false,
    pair: null,
    ...extra,
});

/** quote_request (SYNC, app → issuer), application_create + its callback, a webhook. */
export function fdFlow(): Flow {
    return {
        id: FLOW_ID,
        sequence: [
            step('quote_request', 'BAP', { expect: true }),
            step('application_create', 'BAP'),
            step('on_application_create', 'BPP'),
            step('on_application_state_change', 'BPP'),
        ],
    };
}

export function fdSession(npType: 'BAP' | 'BPP' = 'BAP'): SessionCache {
    return {
        transactionIds: [TXN_ID],
        flowMap: { [FLOW_ID]: TXN_ID },
        npType,
        domain: FD,
        version: FD_VERSION,
        subscriberId: NP_ID,
        subscriberUrl: NP_URL,
        usecaseId: 'FD',
        env: 'STAGING',
        flowConfigs: { [FLOW_ID]: fdFlow() },
    };
}

export interface SeededFd {
    cache0: ICacheService;
    workbenchCache: WorkbenchCacheServiceType;
    ctx: FlowContext;
}

/** Caches holding one FD transaction of `fdFlow()`, and its flow context. */
export async function seedFd(
    npType: 'BAP' | 'BPP' = 'BAP',
    apiList: HistoryType[] = []
): Promise<SeededFd> {
    const cache0 = createCache('mock');
    const workbenchCache = WorkbenchCacheService(cache0);
    const session = fdSession(npType);
    const transactionData = {
        sessionId: SESSION_ID,
        flowId: FLOW_ID,
        latestAction: '',
        latestTimestamp: '',
        subscriberType: npType,
        messageIds: [],
        apiList,
    };
    await cache0.set(SESSION_ID, session, {} as never);
    await cache0.set(`${TXN_ID}::${NP_URL}`, transactionData, {} as never);
    const ctx: FlowContext = {
        flow: fdFlow(),
        flowId: FLOW_ID,
        transactionId: TXN_ID,
        sessionId: SESSION_ID,
        subscriberUrl: NP_URL,
        apiSessionCache: session,
        transactionData,
        domain: FD,
        version: FD_VERSION,
    };
    return { cache0, workbenchCache, ctx };
}

export type FakeFdTxn = jest.Mocked<FdTransaction> & { calls: string[] };

/** A fake engine transaction that records the order of its calls. */
export function fakeFdTxn(
    opts: {
        replayOf?: string;
        draftBody?: Record<string, unknown>;
        pathParams?: Record<string, string>;
        httpStatus?: number;
        stored?: {
            action: string;
            body: unknown;
            pathParams: Record<string, string>;
        };
    } = {}
): FakeFdTxn {
    const calls: string[] = [];
    const txn = {
        role: 'DEPOSIT_ISSUER' as const,
        calls,
        observe: jest.fn(async () => {
            calls.push('observe');
            return {
                findings: [{ rule: 'r1', detail: 'a finding' }],
                replayOf: opts.replayOf,
            };
        }),
        draft: jest.fn(async () => {
            calls.push('draft');
            return {
                body: opts.draftBody ?? {
                    context: { action: 'quote_request', message_id: 'm-draft' },
                    fdEnvelope: { mode: 'SYNC' },
                    message: { quote: { quoteId: 'Q-1' } },
                },
                pathParams: opts.pathParams ?? {},
                httpStatus: opts.httpStatus,
            };
        }),
        sent: jest.fn(() => {
            calls.push('sent');
        }),
        replayFor: jest.fn(() => opts.stored),
        save: jest.fn(async () => {
            calls.push('save');
        }),
    };
    return txn as unknown as FakeFdTxn;
}

/** A fake MockRunner: one config step per action id, and a generate script. */
export function fakeRunner(
    steps: { action_id: string; mock: Record<string, unknown> }[],
    generate: (
        actionId: string,
        session: Record<string, unknown>
    ) => unknown = (_id, session) => session.fd_draft
) {
    return {
        getConfig: jest.fn(() => ({ steps })),
        runMeetRequirementsWithSession: jest.fn(async () => ({
            success: true,
            result: { valid: true },
        })),
        runGeneratePayloadWithSession: jest.fn(
            async (actionId: string, session: Record<string, unknown>) => ({
                success: true,
                result: generate(actionId, session),
            })
        ),
    };
}

export type FakeRes = Response & {
    status: jest.Mock;
    json: jest.Mock;
};

export function fakeRes(): FakeRes {
    const res = {
        headersSent: false,
        status: jest.fn(),
        json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.json.mockImplementation(() => {
        res.headersSent = true;
        return res;
    });
    return res as unknown as FakeRes;
}
