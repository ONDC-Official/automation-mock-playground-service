import { SequenceStep } from '../../../../types/flow-types';
import { ApiHistory, FlowMap } from '../../../../types/mapped-flow-types';
import { MockStatusCode } from '../../../../types/mock-service-types';

export interface ResolverContext {
    apiData: ApiHistory;
    flowSequence: SequenceStep[];
    subscriberType: 'BAP' | 'BPP';
    flowStatus: MockStatusCode;
    extraFlowStatuses?: ReadonlyMap<string, MockStatusCode>;
}

export interface ResolverState {
    mappedFlow: FlowMap;
    cursor: { value: number };
}

export interface ResolverOutcome {
    consumed: boolean;
}

export type Resolver = (
    ctx: ResolverContext,
    state: ResolverState
) => ResolverOutcome;
