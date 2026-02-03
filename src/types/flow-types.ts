import { z } from 'zod';

export const FormFieldConfigTypeSchema: z.ZodType<unknown> = z.lazy(() =>
    z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(['text', 'select', 'textarea', 'list']),
        payloadField: z.string(),
        values: z.array(z.string()).optional(),
        defaultValue: z.string().optional(),
        input: z.array(FormFieldConfigTypeSchema).optional(),
    })
);

export const FormConfigTypeSchema = z.array(FormFieldConfigTypeSchema);

export const SequenceStepSchema = z.object({
    key: z.string(),
    type: z.string(),
    unsolicited: z.boolean(),
    description: z.string().optional(),
    pair: z.string().nullable(),
    owner: z.enum(['BAP', 'BPP']),
    stackable: z.boolean().optional(),
    input: FormConfigTypeSchema.optional(),
    expect: z.boolean().optional(),
    label: z.string().optional(),
    force_proceed: z.boolean().optional(),
    repeat: z.number().optional(),
});

export const FlowSchema = z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    sequence: z.array(SequenceStepSchema),
});

export const DomainSchema = z.object({
    name: z.string(),
    flows: z.array(FlowSchema),
});

export const FetchFlowsResponseSchema = z.object({
    domain: z.array(DomainSchema),
});

export type FormFieldConfigType = z.infer<typeof FormFieldConfigTypeSchema>;
export type FormConfigType = z.infer<typeof FormConfigTypeSchema>;
export type SequenceStep = z.infer<typeof SequenceStepSchema>;
export type Flow = z.infer<typeof FlowSchema>;
export type Domain = z.infer<typeof DomainSchema>;
export type FetchFlowsResponse = z.infer<typeof FetchFlowsResponseSchema>;
