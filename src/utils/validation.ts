import { ZodSchema } from 'zod';
import { httpValidationError } from '../errors/custom-errors';

export function validateOrThrow<T>(
    schema: ZodSchema<T>,
    data: unknown,
    message: string
): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
        throw new httpValidationError(message, [parsed.error.message]);
    }
    return parsed.data;
}
