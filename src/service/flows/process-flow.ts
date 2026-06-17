import { IQueueService } from '../../queue/IQueueService';
import { FlowContext } from '../../types/process-flow-types';
import { MappedStep } from '../../types/mapped-flow-types';
import { MockStatusCode } from '../../types/mock-service-types';
import { SequenceStep } from '../../types/flow-types';
import logger from '../../utils/logger';
import { setTraceContext } from '../../utils/trace-context';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import {
    GENERATE_PAYLOAD_JOB,
    GenerateMockPayloadJobParams,
} from '../jobs/generate-response';
import { getNextActions } from './flow-mapper';
import {
    API_SERVICE_FORM_REQUEST_JOB,
    ApiServiceFormRequestJobParams,
} from '../jobs/api-service-form-request';

export type ActionUponFlowResponse = {
    success: boolean;
    message?: string;
    data?: unknown;
    jobIds?: string[];
    inputs?: unknown;
};

const FORM_TYPES = new Set(['HTML_FORM', 'DYNAMIC_FORM', 'HTML_FORM_MULTI']);
const DISPATCH_STATUSES = new Set<MappedStep['status']>([
    'RESPONDING',
    'INPUT-REQUIRED',
    'WAITING-SUBMISSION',
]);

export async function actOnFlowService(
    params: FlowContext,
    workbenchCache: WorkbenchCacheServiceType,
    queueService: IQueueService
): Promise<ActionUponFlowResponse> {
    setTraceContext({
        transactionId: params.transactionId,
        sessionId: params.sessionId,
        flowId: params.flowId,
        domain: params.domain,
        version: params.version,
    });
    const loggingMeta = {
        transactionId: params.transactionId,
        flowId: params.flowId,
        domain: params.domain,
        version: params.version,
    };

    const flowStatus = await workbenchCache
        .FlowStatusCacheService()
        .getFlowStatus(params.transactionId, params.subscriberUrl, loggingMeta);

    if (flowStatus.status === 'SUSPENDED') {
        return {
            success: false,
            message: 'Flow is suspended, cannot process further',
        };
    }

    const businessCache = await workbenchCache
        .TxnBusinessCacheService()
        .getMockSessionData(
            params.transactionId,
            params.subscriberUrl,
            params.sessionId
        );

    const extraFlowStatuses = await loadExtraFlowStatuses(
        params,
        workbenchCache,
        loggingMeta
    );

    const { sequenceNext, extrasNext } = getNextActions(
        params.transactionData,
        params.flow,
        flowStatus.status,
        businessCache,
        extraFlowStatuses
    );

    const hasInputs = params.inputs !== undefined;
    const hasTriggerExtra = !!params.trigger_extra;

    type Target = { step: MappedStep; consumesInputs: boolean };
    const targets: Target[] = [];
    let sequenceAwaitingInputs: MappedStep | null = null;

    // Sequence auto-dispatch: inputs route to sequence iff trigger_extra is NOT set.
    if (
        sequenceNext &&
        DISPATCH_STATUSES.has(sequenceNext.status) &&
        flowStatus.status === 'AVAILABLE'
    ) {
        if (sequenceNext.status === 'INPUT-REQUIRED') {
            const inputsObj = params.inputs as
                | Record<string, unknown>
                | undefined;
            // Manual steps need a matching { id } trigger and never feed it to
            // the runner; non-manual (form) INPUT-REQUIRED keeps prior behavior.
            const manualReady =
                sequenceNext.manual === true
                    ? inputsObj?.id === sequenceNext.actionId
                    : hasInputs;
            if (!hasTriggerExtra && manualReady) {
                targets.push({
                    step: sequenceNext,
                    consumesInputs: sequenceNext.manual !== true,
                });
            } else {
                sequenceAwaitingInputs = sequenceNext;
            }
        } else {
            targets.push({
                step: sequenceNext,
                consumesInputs: !hasTriggerExtra && hasInputs,
            });
        }
    }

    // Extras auto-dispatch: RESPONDING / WAITING-SUBMISSION only.
    // INPUT-REQUIRED extras placeholders fire only via trigger_extra.
    for (const x of extrasNext ?? []) {
        if (!DISPATCH_STATUSES.has(x.status)) continue;
        if (x.status === 'INPUT-REQUIRED') continue;
        const stepStatus = extraFlowStatuses.get(x.actionId) ?? 'AVAILABLE';
        if (stepStatus !== 'AVAILABLE') continue;
        targets.push({ step: x, consumesInputs: false });
    }

    // trigger_extra: explicit mock-initiated extras dispatch.
    if (hasTriggerExtra) {
        const step = (params.flow.extraSequence ?? []).find(
            s => s.key === params.trigger_extra
        );
        if (!step) {
            return {
                success: false,
                message: `trigger_extra: unknown extras key "${params.trigger_extra}"`,
            };
        }

        // only allow counter party triggers
        if (step.owner === params.transactionData.subscriberType) {
            return {
                success: false,
                message: `trigger_extra: step "${step.key}" is owned by ${step.owner}, not ${params.transactionData.subscriberType}`,
            };
        }
       
        const triggerStatus = extraFlowStatuses.get(step.key) ?? 'AVAILABLE';
        if (triggerStatus !== 'AVAILABLE') {
            return {
                success: false,
                message: `trigger_extra: step "${step.key}" is ${triggerStatus}, cannot dispatch`,
            };
        }
        // Prefer existing placeholder (preserves awaitingMessageId for callback match).
        const existing = (extrasNext ?? []).find(
            x => x.actionId === step.key && DISPATCH_STATUSES.has(x.status)
        );
        const target: MappedStep = existing ?? synthExtraTarget(step);
        const already = targets.find(t => t.step === target);
        if (already) {
            already.consumesInputs = hasInputs;
        } else {
            targets.push({ step: target, consumesInputs: hasInputs });
        }
    }

    if (targets.length === 0 && !sequenceAwaitingInputs) {
        if (
            sequenceNext?.status === 'LISTENING' &&
            sequenceNext.expect &&
            params.transactionData.sessionId
        ) {
            await workbenchCache
                .SubscriberCacheService()
                .createExpectation(
                    params.subscriberUrl,
                    params.flowId,
                    params.transactionData.sessionId,
                    sequenceNext.actionType
                );
            return {
                success: true,
                message: 'Mock Service is now listening for the next action',
            };
        }
        if (flowStatus.status === 'WORKING') {
            return {
                success: false,
                message: 'Flow is already being processed',
            };
        }
        if (!sequenceNext && (!extrasNext || extrasNext.length === 0)) {
            return {
                success: true,
                message: 'No further action required for the flow',
            };
        }
        return {
            success: true,
            message: 'No actionable step for this subscriber',
        };
    }

    const jobIds: string[] = [];
    for (const t of targets) {
        const jobId = await dispatchTarget(
            t.step,
            t.consumesInputs,
            params,
            workbenchCache,
            queueService,
            businessCache
        );
        jobIds.push(jobId);
    }

    if (sequenceAwaitingInputs) {
        const messages: string[] = [];
        if (jobIds.length > 0) {
            messages.push(`dispatched ${jobIds.length} job(s)`);
        }
        messages.push(
            `sequence step "${sequenceAwaitingInputs.actionId}" needs inputs`
        );
        return {
            success: true,
            message: messages.join('; '),
            inputs: sequenceAwaitingInputs.input,
            ...(jobIds.length > 0 ? { jobIds } : {}),
        };
    }

    return {
        success: true,
        message:
            targets.length === 1
                ? 'server is now responding with the mock data'
                : `dispatched ${targets.length} jobs`,
        jobIds,
    };
}

function synthExtraTarget(step: SequenceStep): MappedStep {
    return {
        status: 'RESPONDING',
        actionId: step.key,
        owner: step.owner,
        actionType: step.type,
        input: step.input,
        index: -1,
        unsolicited: step.unsolicited,
        pairActionId: step.pair,
        description: step.description,
        label: step.label,
        isExtraStep: true,
    };
}

async function loadExtraFlowStatuses(
    params: FlowContext,
    workbenchCache: WorkbenchCacheServiceType,
    loggingMeta: unknown
): Promise<Map<string, MockStatusCode>> {
    const statuses = new Map<string, MockStatusCode>();
    const extraSequence = params.flow.extraSequence ?? [];
    if (extraSequence.length === 0) return statuses;

    const svc = workbenchCache.FlowStatusCacheService();
    for (const step of extraSequence) {
        const s = await svc.getExtraFlowStatus(
            params.transactionId,
            params.subscriberUrl,
            step.key,
            loggingMeta
        );
        statuses.set(step.key, s.status);
    }
    return statuses;
}

async function dispatchTarget(
    target: MappedStep,
    consumesInputs: boolean,
    params: FlowContext,
    workbenchCache: WorkbenchCacheServiceType,
    queueService: IQueueService,
    businessCache: Record<string, unknown>
): Promise<string> {
    const isExtra = target.isExtraStep === true;
    setTraceContext({ action: target.actionType, actionId: target.actionId });

    if (isExtra) {
        await workbenchCache
            .FlowStatusCacheService()
            .setExtraFlowStatus(
                params.transactionId,
                params.subscriberUrl,
                target.actionId,
                'WORKING'
            );
    } else {
        await workbenchCache
            .FlowStatusCacheService()
            .setFlowStatus(
                params.transactionId,
                params.subscriberUrl,
                'WORKING'
            );
    }

    if (FORM_TYPES.has(target.actionType)) {
        // Forms are sequence-only by validation; this path never fires for extras.
        if (
            !params.inputs ||
            (params.inputs as Record<string, unknown>).submission_id ===
                undefined
        ) {
            throw new Error(
                'submission_id is required in inputs to proceed dynamic form'
            );
        }
        const submissionId = (params.inputs as Record<string, unknown>)
            .submission_id as string;

        await workbenchCache
            .TxnBusinessCacheService()
            .addFormSubmissionId(
                params.transactionId,
                params.subscriberUrl,
                params.transactionData.sessionId!,
                target.actionId,
                submissionId
            );
        const formParams: ApiServiceFormRequestJobParams = {
            domain: params.domain,
            version: params.version,
            subscriberUrl: params.subscriberUrl,
            transactionId: params.transactionId,
            formActionId: target.actionId,
            formType: target.actionType,
            submissionId,
        };
        return queueService.enqueue(API_SERVICE_FORM_REQUEST_JOB, formParams);
    }

    // Plain API dispatch — only the target marked consumesInputs receives params.inputs.
    if (consumesInputs) {
        businessCache.user_inputs = params.inputs as Record<string, unknown>;
    }
    logger.info(
        `Enqueuing job to generate payload for transaction: ${params.transactionId}${
            isExtra ? ` (extras step ${target.actionId})` : ''
        }${consumesInputs ? ' [consumes user inputs]' : ''}`
    );
    const queParams: GenerateMockPayloadJobParams = {
        flowContext: params,
        inputs: consumesInputs ? params.inputs : undefined,
        actionMeta: target,
    };
    return queueService.enqueue(GENERATE_PAYLOAD_JOB, queParams);
}
