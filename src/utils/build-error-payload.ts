import { MappedStep } from '../types/mapped-flow-types';
import { FlowContext } from '../types/process-flow-types';
import { createGenericContext } from './create-generic-context';

export function buildErrorPayload(
    flowContext: FlowContext,
    actionMeta: MappedStep,
    code: string,
    message: string,
    shortDesc: string,
    longDesc: string
) {
    return {
        context: createGenericContext(
            flowContext.domain,
            flowContext.version,
            actionMeta.actionType,
            flowContext.transactionId,
            flowContext.subscriberUrl
        ),
        error: {
            code,
            message,
            paths: longDesc,
            tags: [
                {
                    descriptor: {
                        short_desc: shortDesc,
                        long_desc: longDesc,
                    },
                },
            ],
        },
    };
}
