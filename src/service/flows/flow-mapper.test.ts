import {
    getFlowCompleteStatus,
    getNextActionMetaData,
    getNextActions,
} from './flow-mapper';
import { Flow, SequenceStep } from '../../types/flow-types';
import { HistoryType, TransactionCache } from '../../types/cache-types';
import {
    MockSessionCache,
    MockStatusCode,
} from '../../types/mock-service-types';

// ---------- builders ----------

const makeStep = (
    overrides: Partial<SequenceStep> & {
        key: string;
        type: string;
        owner: 'BAP' | 'BPP';
    }
): SequenceStep => ({
    unsolicited: false,
    pair: null,
    ...overrides,
});

const makeFlow = (
    id: string,
    sequence: SequenceStep[],
    extraSequence?: SequenceStep[]
): Flow => ({
    id,
    sequence,
    ...(extraSequence ? { extraSequence } : {}),
});

const apiHistory = (
    action: string,
    messageId: string,
    timestamp: string,
    opts: { ack?: 'ACK' | 'NACK'; payloadId?: string } = {}
): HistoryType => ({
    entryType: 'API',
    action,
    payloadId: opts.payloadId ?? `${action}-${messageId}-p1`,
    messageId,
    response: { message: { ack: { status: opts.ack ?? 'ACK' } } },
    timestamp,
});

const formHistory = (
    formType: 'HTML_FORM' | 'DYNAMIC_FORM' | 'RES_FORM',
    formId: string,
    timestamp: string,
    opts: { submissionId?: string; error?: string } = {}
): HistoryType => ({
    entryType: 'FORM',
    formType,
    formId,
    submissionId: opts.submissionId,
    timestamp,
    ...(opts.error ? { error: opts.error } : {}),
});

const makeTxn = (
    apiList: HistoryType[],
    subscriberType: 'BAP' | 'BPP' = 'BAP'
): TransactionCache => ({
    flowId: 'flow1',
    latestAction: 'search',
    latestTimestamp: '2024-01-01T00:00:00.000Z',
    subscriberType,
    messageIds: [],
    apiList,
});

const emptySession: MockSessionCache = {};

// ---------- tests ----------

describe('flow-mapper', () => {
    describe('getFlowCompleteStatus — empty history', () => {
        it('marks first step LISTENING (subscriber == owner) and the rest WAITING', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                makeStep({ key: 'k3', type: 'select', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence.map(s => s.status)).toEqual([
                'LISTENING',
                'WAITING',
                'WAITING',
            ]);
            expect(result.missedSteps).toEqual([]);
        });

        it('marks first step RESPONDING when subscriber != owner and no input', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'on_search', owner: 'BPP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('RESPONDING');
        });

        it('marks first step INPUT-REQUIRED when subscriber != owner, has input, AVAILABLE', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'on_search',
                    owner: 'BPP',
                    input: [{ name: 'field1' }],
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('INPUT-REQUIRED');
        });

        it('regular step: subscriber != owner, unsolicited, no input → single auto-submit INPUT-REQUIRED', () => {
            // unsolicited+no-input emits ONLY the empty-input INPUT-REQUIRED the
            // UI auto-proceeds to fire the send; no RESPONDING twin.
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'on_update',
                    owner: 'BPP',
                    unsolicited: true,
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('INPUT-REQUIRED');
            expect(result.sequence[0].input).toEqual([]);
        });
    });

    describe('getFlowCompleteStatus — HTML_FORM / DYNAMIC_FORM pending status', () => {
        it('form step: subscriber == owner, AVAILABLE → INPUT-REQUIRED', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('INPUT-REQUIRED');
        });

        it('form step: subscriber == owner, WORKING → PROCESSING', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'WORKING',
                emptySession
            );
            expect(result.sequence[0].status).toBe('PROCESSING');
        });

        it('form step: subscriber != owner, AVAILABLE → WAITING-SUBMISSION', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'HTML_FORM',
                    owner: 'BPP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('WAITING-SUBMISSION');
        });

        it('form step: subscriber != owner, WORKING → RESPONDING', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'HTML_FORM',
                    owner: 'BPP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'WORKING',
                emptySession
            );
            expect(result.sequence[0].status).toBe('RESPONDING');
        });
    });

    describe('getFlowCompleteStatus — API sequencing (happy path)', () => {
        it('marks matched APIs as COMPLETE in order and remaining as pending', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                makeStep({ key: 'k3', type: 'select', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                        apiHistory('on_search', 'm2', '2024-01-01T00:00:01.000Z'),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );

            expect(result.sequence.map(s => s.status)).toEqual([
                'COMPLETE',
                'COMPLETE',
                'LISTENING',
            ]);
            expect(result.sequence[0].actionId).toBe('k1');
            expect(result.sequence[1].actionId).toBe('k2');
            expect(result.sequence[2].actionId).toBe('k3');
            expect(result.missedSteps).toEqual([]);
        });

        it('sorts history chronologically before matching, even if input order is reversed', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        // intentionally out of chronological order
                        apiHistory('on_search', 'm2', '2024-01-01T00:00:01.000Z'),
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence.map(s => s.status)).toEqual([
                'COMPLETE',
                'COMPLETE',
            ]);
            expect(result.missedSteps).toEqual([]);
        });

        it('preserves description/label/input from the matched flow step', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'search',
                    owner: 'BAP',
                    description: 'do a search',
                    label: 'Search',
                    input: [{ name: 'q' }],
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].description).toBe('do a search');
            expect(result.sequence[0].label).toBe('Search');
            expect(result.sequence[0].input).toEqual([{ name: 'q' }]);
        });
    });

    describe('getFlowCompleteStatus — API sequencing (mismatches)', () => {
        it('out-of-order API (type exists later) → missed step with futureStepIndex and pointer unchanged', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                makeStep({ key: 'k3', type: 'select', owner: 'BAP' }),
            ]);
            // user sends select before search
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('select', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps).toHaveLength(1);
            expect(result.missedSteps[0]).toMatchObject({
                actionId: 'select',
                index: 2,
                missedStep: true,
                description: expect.stringContaining('out of order'),
            });
            // sequence still expects k1 next (pointer didn't advance)
            expect(result.sequence[0].actionId).toBe('k1');
            expect(result.sequence[0].status).toBe('LISTENING');
        });

        it('unknown API (not in flow) → missed step with index -1', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_cancel',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps[0]).toMatchObject({
                actionId: 'on_cancel',
                index: -1,
                owner: 'BPP', // derived from on_ prefix
                description: 'action not found in flow sequence',
            });
        });

        it('API beyond flow length → missed step with "beyond flow sequence"', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                        apiHistory(
                            'on_search',
                            'm2',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('COMPLETE');
            expect(result.missedSteps).toHaveLength(1);
            expect(result.missedSteps[0]).toMatchObject({
                actionId: 'on_search',
                index: -1,
                description: 'action beyond flow sequence',
            });
        });

        it('derives owner from on_ prefix for missed actions', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('unknown', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps[0].owner).toBe('BAP');
        });
    });

    describe('getFlowCompleteStatus — FORM sequencing', () => {
        it('form match at expected step advances pointer', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
                makeStep({ key: 'k2', type: 'init', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        formHistory(
                            'DYNAMIC_FORM',
                            'form1',
                            '2024-01-01T00:00:00.000Z',
                            { submissionId: 'sub1' }
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('COMPLETE');
            expect(result.sequence[0].actionId).toBe('form1');
            expect(result.sequence[1].status).toBe('LISTENING');
        });

        it('form out of order (type exists later) → missed step', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                makeStep({
                    key: 'form1',
                    type: 'HTML_FORM',
                    owner: 'BAP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        formHistory(
                            'HTML_FORM',
                            'form1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps).toHaveLength(1);
            expect(result.missedSteps[0]).toMatchObject({
                actionId: 'form1',
                actionType: 'HTML_FORM',
                owner: 'BAP',
                index: 1,
                description: expect.stringContaining('out of order'),
            });
            // pointer not advanced
            expect(result.sequence[0].actionId).toBe('k1');
        });

        it('form not in flow → missed step with index -1', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        formHistory(
                            'HTML_FORM',
                            'ghost-form',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps[0]).toMatchObject({
                actionId: 'ghost-form',
                index: -1,
                description: 'form not found in flow sequence',
            });
        });

        it('form beyond flow length → missed step "form beyond flow sequence"', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        formHistory(
                            'DYNAMIC_FORM',
                            'form1',
                            '2024-01-01T00:00:00.000Z',
                            { submissionId: 'sub1' }
                        ),
                        formHistory(
                            'DYNAMIC_FORM',
                            'form2',
                            '2024-01-01T00:00:01.000Z',
                            { submissionId: 'sub2' }
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('COMPLETE');
            expect(result.missedSteps[0].description).toBe(
                'form beyond flow sequence'
            );
        });
    });

    describe('getFlowCompleteStatus — MORE_SEQUENCE extension', () => {
        it('appends MORE_SEQUENCE steps to flow sequence', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const session: MockSessionCache = {
                MORE_SEQUENCE: [
                    makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                ],
            };
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                        apiHistory(
                            'on_search',
                            'm2',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                session
            );
            expect(result.sequence.map(s => s.status)).toEqual([
                'COMPLETE',
                'COMPLETE',
            ]);
            expect(result.missedSteps).toEqual([]);
        });
    });

    describe('getFlowCompleteStatus — reference_data', () => {
        it('collects HTML_FORM/DYNAMIC_FORM session values into reference_data', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'kycForm',
                    type: 'HTML_FORM',
                    owner: 'BAP',
                }),
                makeStep({ key: 'k2', type: 'search', owner: 'BAP' }),
                makeStep({
                    key: 'dynForm',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
            ]);
            const session: MockSessionCache = {
                kycForm: '<html>resolved-kyc</html>',
                dynForm: ['dynamic-value-0', 'dynamic-value-1'],
            };
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                session
            );
            expect(result.reference_data).toEqual({
                kycForm: '<html>resolved-kyc</html>',
                dynForm: 'dynamic-value-0', // arrays: first element only
            });
        });
    });

    describe('reduceApiDataList behavior (via getFlowCompleteStatus)', () => {
        it('dedupes identical action|messageId into a single matched step but accumulates payloads', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'on_search', owner: 'BPP' }),
                makeStep({ key: 'k2', type: 'select', owner: 'BAP' }),
            ]);
            // Same action+messageId, different payloadId (e.g. NACK then ACK)
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        {
                            ...apiHistory(
                                'on_search',
                                'm1',
                                '2024-01-01T00:00:00.000Z',
                                {
                                    ack: 'NACK',
                                    payloadId: 'p-nack',
                                }
                            ),
                        },
                        {
                            ...apiHistory(
                                'on_search',
                                'm1',
                                '2024-01-01T00:00:01.000Z',
                                {
                                    ack: 'ACK',
                                    payloadId: 'p-ack',
                                }
                            ),
                        },
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('COMPLETE');
            const payloads = result.sequence[0].payloads;
            expect(payloads?.entryType).toBe('API');
            if (payloads?.entryType === 'API') {
                // subStatus reflects the FIRST entry's ack outcome (NACK)
                expect(payloads.subStatus).toBe('ERROR');
                expect(payloads.payloads).toHaveLength(2);
                expect(payloads.payloads.map(p => p.payloadId)).toEqual([
                    'p-nack',
                    'p-ack',
                ]);
            }
        });

        it('subStatus is SUCCESS for a perfect ACK', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            const payloads = result.sequence[0].payloads;
            if (payloads?.entryType === 'API') {
                expect(payloads.subStatus).toBe('SUCCESS');
            }
        });

        it('dedupes forms by formType|formId|submissionId', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'form1',
                    type: 'DYNAMIC_FORM',
                    owner: 'BAP',
                }),
                makeStep({ key: 'k2', type: 'init', owner: 'BAP' }),
            ]);
            // Two history entries for the same form+submission — should collapse to one.
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        formHistory(
                            'DYNAMIC_FORM',
                            'form1',
                            '2024-01-01T00:00:00.000Z',
                            { submissionId: 'sub1' }
                        ),
                        formHistory(
                            'DYNAMIC_FORM',
                            'form1',
                            '2024-01-01T00:00:01.000Z',
                            { submissionId: 'sub1' }
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            // If dedup worked, form matches step 0 once and we advance to k2.
            expect(result.sequence[0].status).toBe('COMPLETE');
            expect(result.sequence[1].status).toBe('LISTENING');
            expect(result.missedSteps).toEqual([]);
        });
    });

    describe('getNextActionMetaData', () => {
        const flow = makeFlow('f1', [
            makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
        ]);

        it('returns the first non-COMPLETE actionable step', () => {
            const next = getNextActionMetaData(
                makeTxn(
                    [apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(next?.actionId).toBe('k2');
            expect(next?.status).toBe('RESPONDING');
        });

        it('returns the first step when no APIs have run', () => {
            const next = getNextActionMetaData(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(next?.actionId).toBe('k1');
            expect(next?.status).toBe('LISTENING');
        });

        it('returns undefined when flow is fully complete', () => {
            const next = getNextActionMetaData(
                makeTxn(
                    [
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                        apiHistory(
                            'on_search',
                            'm2',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(next).toBeUndefined();
        });
    });

    // ============================================================
    // extraSequence / extraSteps tests (E1–E17)
    // ============================================================

    describe('extras — basic matching', () => {
        it('E1: empty extraSequence + unknown action still goes to missedSteps', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_cancel',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps).toHaveLength(1);
            expect(result.extraSteps ?? []).toEqual([]);
        });

        it('E2: extras match, no pair → one COMPLETE entry in extraSteps; nothing in missedSteps', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-on-cancel',
                        type: 'on_cancel',
                        owner: 'BPP',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_cancel',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.missedSteps).toEqual([]);
            expect(result.extraSteps).toHaveLength(1);
            expect(result.extraSteps![0]).toMatchObject({
                status: 'COMPLETE',
                actionId: 'extra-on-cancel',
                actionType: 'on_cancel',
                owner: 'BPP',
                isExtraStep: true,
            });
        });

        it('E3: extras match with pair → COMPLETE entry + placeholder with status from buildPendingStep', () => {
            // subscriber=BAP, mock acts as BPP. on_update arrives unsolicited;
            // its pair is update (owner=BAP). Placeholder for update: subscriber==owner → LISTENING.
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                    }),
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'extra-update',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.extraSteps).toHaveLength(2);
            expect(result.extraSteps![0]).toMatchObject({
                status: 'COMPLETE',
                actionId: 'extra-on-update',
                isExtraStep: true,
            });
            expect(result.extraSteps![1]).toMatchObject({
                status: 'LISTENING',
                actionId: 'extra-update',
                isExtraStep: true,
                awaitingMessageId: 'm1',
            });
        });
    });

    describe('extras — pair resolution', () => {
        const buildFlow = () =>
            makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                    }),
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'extra-update',
                    }),
                ]
            );

        it('E4: A fires, then B (pair) with same messageId → both COMPLETE, no orphans', () => {
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                        apiHistory(
                            'update',
                            'm1',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                buildFlow(),
                'AVAILABLE',
                emptySession
            );
            expect(result.extraSteps).toHaveLength(2);
            expect(result.extraSteps!.every(s => s.status === 'COMPLETE')).toBe(
                true
            );
            // Resolved placeholder now has payloads set
            const updateEntry = result.extraSteps!.find(
                s => s.actionId === 'extra-update'
            );
            expect(updateEntry?.payloads?.entryType).toBe('API');
        });

        it('E5: B fires first, then A → bidirectional resolution works', () => {
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                buildFlow(),
                'AVAILABLE',
                emptySession
            );
            expect(result.extraSteps).toHaveLength(2);
            expect(result.extraSteps!.every(s => s.status === 'COMPLETE')).toBe(
                true
            );
        });

        it('E6: same extras key fires twice with different messageIds → two independent sub-flows', () => {
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                        apiHistory(
                            'on_update',
                            'm2',
                            '2024-01-01T00:00:01.000Z'
                        ),
                    ],
                    'BAP'
                ),
                buildFlow(),
                'AVAILABLE',
                emptySession
            );
            // 2 COMPLETE on_update entries + 2 placeholders for update (m1 + m2)
            expect(result.extraSteps).toHaveLength(4);
            const placeholders = result.extraSteps!.filter(
                s => s.actionId === 'extra-update'
            );
            expect(placeholders).toHaveLength(2);
            const awaitingIds = placeholders
                .map(p => p.awaitingMessageId)
                .sort();
            expect(awaitingIds).toEqual(['m1', 'm2']);
        });
    });

    describe('extras — interactions with strict sequence', () => {
        it('E7: out-of-order strict action that ALSO matches extras → lands in extraSteps (NOT missed)', () => {
            // search expected at cursor; select would be out-of-order; on_update is in extras.
            const flow = makeFlow(
                'f1',
                [
                    makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                    makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                    makeStep({ key: 'k3', type: 'on_update', owner: 'BPP' }),
                ],
                [
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            // Should go to extras, NOT missedSteps
            expect(result.missedSteps).toEqual([]);
            expect(result.extraSteps).toHaveLength(1);
            expect(result.extraSteps![0].actionId).toBe('extra-on-update');
        });

        it('E8: out-of-order strict action NOT in extras → missedSteps with out-of-order', () => {
            const flow = makeFlow(
                'f1',
                [
                    makeStep({ key: 'k1', type: 'search', owner: 'BAP' }),
                    makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                    makeStep({ key: 'k3', type: 'select', owner: 'BAP' }),
                ],
                [] // no extras
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('select', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.extraSteps ?? []).toEqual([]);
            expect(result.missedSteps).toHaveLength(1);
            expect(result.missedSteps[0]).toMatchObject({
                description: expect.stringContaining('out of order'),
                index: 2,
            });
        });

        it('E10: action in BOTH strict cursor AND extras → strict consumes; extras gets nothing', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-search',
                        type: 'search',
                        owner: 'BAP',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z')],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('COMPLETE');
            expect(result.sequence[0].actionId).toBe('k1');
            expect(result.extraSteps ?? []).toEqual([]);
        });

        it('E15: MORE_SEQUENCE + extras coexist independently', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                    }),
                ]
            );
            const session: MockSessionCache = {
                MORE_SEQUENCE: [
                    makeStep({ key: 'k2', type: 'on_search', owner: 'BPP' }),
                ],
            };
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory('search', 'm1', '2024-01-01T00:00:00.000Z'),
                        apiHistory(
                            'on_search',
                            'm2',
                            '2024-01-01T00:00:01.000Z'
                        ),
                        apiHistory(
                            'on_update',
                            'm3',
                            '2024-01-01T00:00:02.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                session
            );
            // Strict sequence (k1 + k2 via MORE_SEQUENCE) both COMPLETE
            expect(result.sequence.every(s => s.status === 'COMPLETE')).toBe(
                true
            );
            // Extras has the on_update
            expect(result.extraSteps).toHaveLength(1);
            expect(result.extraSteps![0].actionType).toBe('on_update');
        });
    });

    describe('extras — construction validation', () => {
        it('E11: extraSequence with duplicate type → constructor throws', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-a',
                        type: 'on_update',
                        owner: 'BPP',
                    }),
                    makeStep({
                        key: 'extra-b',
                        type: 'on_update',
                        owner: 'BPP',
                    }),
                ]
            );
            expect(() =>
                getFlowCompleteStatus(
                    makeTxn([], 'BAP'),
                    flow,
                    'AVAILABLE',
                    emptySession
                )
            ).toThrow(/duplicate type/);
        });

        it('E12: extraSequence with HTML_FORM entry → constructor throws', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'bad-form',
                        type: 'HTML_FORM',
                        owner: 'BAP',
                    }),
                ]
            );
            expect(() =>
                getFlowCompleteStatus(
                    makeTxn([], 'BAP'),
                    flow,
                    'AVAILABLE',
                    emptySession
                )
            ).toThrow(/form-type/);
        });
    });

    describe('extras — pair edge cases', () => {
        it('E9: pair points at missing key → COMPLETE pushed, no placeholder, no throw', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-a',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'does-not-exist',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.extraSteps).toHaveLength(1);
            expect(result.extraSteps![0].status).toBe('COMPLETE');
        });

        it('E13: getNextActions returns {sequenceNext, extrasNext}; placeholders surface in extrasNext', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                    }),
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'extra-update',
                    }),
                ]
            );
            const next = getNextActions(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(next.sequenceNext?.actionId).toBe('k1');
            expect(next.sequenceNext?.status).toBe('LISTENING');
            expect(next.extrasNext).toHaveLength(1);
            expect(next.extrasNext![0]).toMatchObject({
                actionId: 'extra-update',
                status: 'LISTENING',
                isExtraStep: true,
                awaitingMessageId: 'm1',
            });
        });

        it('E14: getNextActionMetaData (back-compat alias) returns ONLY sequenceNext', () => {
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'extra-update',
                    }),
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                    }),
                ]
            );
            const next = getNextActionMetaData(
                makeTxn(
                    [
                        apiHistory(
                            'on_update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            // The alias returns the sequenceNext only — should be k1 LISTENING,
            // NOT the extras placeholder.
            expect(next?.actionId).toBe('k1');
            expect(next?.isExtraStep).toBeUndefined();
        });

        it('E16: extras-status WORKING → placeholder uses RESPONDING (not INPUT-REQUIRED) for input-bearing pair', () => {
            // Pair step has input and subscriber != owner: status flips on AVAILABLE vs WORKING.
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                        input: [{ name: 'field1' }],
                    }),
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        pair: 'extra-update',
                        input: [{ name: 'field1' }],
                    }),
                ]
            );

            // subscriber=BPP so the placeholder for `extra-update` (owner=BAP) has
            // subscriber != owner. With input, status is AVAILABLE → INPUT-REQUIRED;
            // WORKING → RESPONDING.
            const history = [
                apiHistory('on_update', 'm1', '2024-01-01T00:00:00.000Z'),
            ];

            // Default: no extras-status map → falls back to main flowStatus (AVAILABLE).
            const resAvailable = getFlowCompleteStatus(
                makeTxn(history, 'BPP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            const phA = resAvailable.extraSteps!.find(
                s => s.actionId === 'extra-update'
            );
            expect(phA?.status).toBe('INPUT-REQUIRED');

            // With extras-status WORKING for the pair step → RESPONDING.
            const extraStatuses = new Map<string, MockStatusCode>([
                ['extra-update', 'WORKING'],
            ]);
            const resWorking = getFlowCompleteStatus(
                makeTxn(history, 'BPP'),
                flow,
                'AVAILABLE',
                emptySession,
                extraStatuses
            );
            const phW = resWorking.extraSteps!.find(
                s => s.actionId === 'extra-update'
            );
            expect(phW?.status).toBe('RESPONDING');
        });

        it('E17: unsolicited && !input pair (subscriber != owner) → single INPUT-REQUIRED placeholder', () => {
            // pair step is owner=BPP, unsolicited, no input. subscriber=BAP.
            // buildPendingStep returns ONE entry (auto-submit INPUT-REQUIRED).
            const flow = makeFlow(
                'f1',
                [makeStep({ key: 'k1', type: 'search', owner: 'BAP' })],
                [
                    makeStep({
                        key: 'extra-update',
                        type: 'update',
                        owner: 'BAP',
                        pair: 'extra-on-update',
                    }),
                    makeStep({
                        key: 'extra-on-update',
                        type: 'on_update',
                        owner: 'BPP',
                        unsolicited: true,
                        pair: 'extra-update',
                    }),
                ]
            );
            const result = getFlowCompleteStatus(
                makeTxn(
                    [
                        apiHistory(
                            'update',
                            'm1',
                            '2024-01-01T00:00:00.000Z'
                        ),
                    ],
                    'BAP'
                ),
                flow,
                'AVAILABLE',
                emptySession
            );
            // 1 COMPLETE for extra-update + 1 placeholder for extra-on-update
            expect(result.extraSteps).toHaveLength(2);
            const placeholders = result.extraSteps!.filter(
                s => s.actionId === 'extra-on-update'
            );
            expect(placeholders).toHaveLength(1);
            expect(placeholders[0].status).toBe('INPUT-REQUIRED');
        });
    });

    describe('manual flag — gates auto-RESPONDING into INPUT-REQUIRED', () => {
        it('manual + subscriber != owner + no input + AVAILABLE → INPUT-REQUIRED', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'on_search',
                    owner: 'BPP',
                    manual: true,
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('INPUT-REQUIRED');
            expect(result.sequence[0].manual).toBe(true);
            // synthetic manual_id input injected, defaulting to the action id
            const input = result.sequence[0].input as Array<
                Record<string, unknown>
            >;
            expect(input).toHaveLength(1);
            expect(input[0].name).toBe('manual_id');
            expect(input[0].type).toBe('manual_id');
            expect(
                (input[0].schema as { properties: { id: { default: string } } })
                    .properties.id.default
            ).toBe('k1');
        });

        it('unsolicited + manual + subscriber != owner + AVAILABLE → only the manual INPUT-REQUIRED (no empty-input auto-submit placeholder)', () => {
            // Regression: unsolicited would push an empty-input INPUT-REQUIRED that
            // the UI auto-submits, bypassing the manual gate and looping. Manual wins.
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'on_search',
                    owner: 'BPP',
                    unsolicited: true,
                    manual: true,
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence).toHaveLength(1);
            expect(result.sequence[0].status).toBe('INPUT-REQUIRED');
            const input = result.sequence[0].input as Array<
                Record<string, unknown>
            >;
            expect(input).toHaveLength(1);
            expect(input[0].name).toBe('manual_id');
        });

        it('manual step reverts to RESPONDING when flow is WORKING (in-flight)', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'on_search',
                    owner: 'BPP',
                    manual: true,
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'WORKING',
                emptySession
            );
            expect(result.sequence[0].status).toBe('RESPONDING');
        });

        it('manual ignored when subscriber == owner → still LISTENING', () => {
            const flow = makeFlow('f1', [
                makeStep({
                    key: 'k1',
                    type: 'search',
                    owner: 'BAP',
                    manual: true,
                }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('LISTENING');
        });

        it('non-manual control: subscriber != owner + no input → RESPONDING', () => {
            const flow = makeFlow('f1', [
                makeStep({ key: 'k1', type: 'on_search', owner: 'BPP' }),
            ]);
            const result = getFlowCompleteStatus(
                makeTxn([], 'BAP'),
                flow,
                'AVAILABLE',
                emptySession
            );
            expect(result.sequence[0].status).toBe('RESPONDING');
            expect(result.sequence[0].manual).toBeUndefined();
        });
    });
});
