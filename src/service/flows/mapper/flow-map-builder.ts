import { TransactionCache } from '../../../types/cache-types';
import { Flow, SequenceStep } from '../../../types/flow-types';
import { FlowMap } from '../../../types/mapped-flow-types';
import {
    MockSessionCache,
    MockStatusCode,
} from '../../../types/mock-service-types';
import { getReferenceData } from '../../../utils/flow-utils';
import { buildPendingStep } from './pending-step';
import { reduceApiDataList } from './reduce-history';
import {
    createEmptyExtrasState,
    createExtrasIndex,
    createExtrasResolver,
    ExtrasIndex,
} from './resolvers/extras-resolver';
import { missedResolver } from './resolvers/missed-resolver';
import {
    Resolver,
    ResolverContext,
    ResolverState,
} from './resolvers/resolver-types';
import { sequenceResolver } from './resolvers/sequence-resolver';

export class FlowMapBuilder {
    private readonly transactionData: TransactionCache;
    private readonly flowSequence: SequenceStep[];
    private readonly extrasIndex: ExtrasIndex;
    private readonly subscriberType: 'BAP' | 'BPP';
    private readonly flowStatus: MockStatusCode;
    private readonly extraFlowStatuses?: ReadonlyMap<string, MockStatusCode>;
    private readonly mappedFlow: FlowMap;
    private readonly cursor = { value: 0 };
    private readonly resolvers: Resolver[];

    constructor(
        transactionData: TransactionCache,
        flow: Flow,
        flowStatus: MockStatusCode,
        mockSessionData: MockSessionCache,
        extraFlowStatuses?: ReadonlyMap<string, MockStatusCode>
    ) {
        this.transactionData = transactionData;
        this.subscriberType = transactionData.subscriberType;
        this.flowStatus = flowStatus;
        this.extraFlowStatuses = extraFlowStatuses;

        const addedSequence = mockSessionData?.MORE_SEQUENCE || [];
        this.flowSequence = [...flow.sequence, ...addedSequence];

        this.extrasIndex = createExtrasIndex(flow.extraSequence ?? []);

        const refData = getReferenceData(mockSessionData, flow);
        this.mappedFlow = {
            sequence: [],
            missedSteps: [],
            extraSteps: [],
            reference_data: refData,
        };

        const extrasState = createEmptyExtrasState();
        this.resolvers = [
            sequenceResolver,
            createExtrasResolver(this.extrasIndex, extrasState),
            missedResolver,
        ];
    }

    build(): FlowMap {
        const apiList = reduceApiDataList(this.transactionData.apiList).sort(
            (a, b) =>
                new Date(a.timestamp).getTime() -
                new Date(b.timestamp).getTime()
        );

        for (const apiData of apiList) {
            const ctx: ResolverContext = {
                apiData,
                flowSequence: this.flowSequence,
                subscriberType: this.subscriberType,
                flowStatus: this.flowStatus,
                extraFlowStatuses: this.extraFlowStatuses,
            };
            const state: ResolverState = {
                mappedFlow: this.mappedFlow,
                cursor: this.cursor,
            };
            for (const resolver of this.resolvers) {
                const outcome = resolver(ctx, state);
                if (outcome.consumed) break;
            }
        }

        for (let i = this.cursor.value; i < this.flowSequence.length; i++) {
            const pendings = buildPendingStep({
                step: this.flowSequence[i],
                index: i,
                isImmediateNext: i === this.cursor.value,
                subscriberType: this.subscriberType,
                flowStatus: this.flowStatus,
            });
            for (const p of pendings) {
                this.mappedFlow.sequence.push(p);
            }
        }

        return this.mappedFlow;
    }
}
