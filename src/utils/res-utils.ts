import { Response } from 'express';
import {
    ERROR_CODES,
    ErrorCodeKey,
    ONDC_ERROR_CODES,
    OndcErrorCodeKey,
} from '../constants/error-codes';
import logger from '@ondc/automation-logger';
import { BecknContext } from '../types/ondc-types';

const resUtilsLogger = logger;

// 1. Define response types for better type safety
export interface SuccessResponse<T = unknown> {
    success: true;
    data: T;
    message: string;
    timestamp?: string;
}

export interface ErrorResponse {
    success: false;
    errorCode: string;
    message: string;
    details?: Record<string, unknown>; // Use 'unknown' instead of 'any'
    timestamp?: string;
}

// 2. Add explicit return type and prevent double-sending
export function sendSuccess<T>(
    res: Response,
    data: T,
    simpleBody = true,
    message = 'OK',
    statusCode = 200
): Response<SuccessResponse<T>> {
    // Guard against already sent responses
    if (res.headersSent) {
        resUtilsLogger.warning(
            'Attempted to send response after headers were sent'
        );
        return res;
    }
    if (simpleBody) {
        return res.status(statusCode).json(data);
    }
    return res.status(statusCode).json({
        success: true,
        data,
        message,
        timestamp: new Date().toISOString(), // Optional: add timestamp
    });
}

// 3. Improved error handling with better fallback
export function sendError(
    res: Response,
    codeKey: ErrorCodeKey,
    customMessage?: string,
    details?: Record<string, unknown>
): Response<ErrorResponse> {
    if (res.headersSent) {
        resUtilsLogger.warning(
            'Attempted to send error after headers were sent'
        );
        return res;
    }

    const errorMeta = ERROR_CODES[codeKey];

    if (!errorMeta) {
        resUtilsLogger.error(`Error Meta not found for code: ${codeKey}`, {
            codeKey,
            customMessage,
        });

        // Return a proper internal error response
        return res.status(500).json({
            success: false,
            errorCode: 'INTERNAL_SERVER_ERROR',
            message: customMessage || 'An unexpected error occurred.',
            timestamp: new Date().toISOString(),
        });
    }

    return res.status(errorMeta.httpStatus).json({
        success: false,
        errorCode: errorMeta.code,
        message: customMessage ?? errorMeta.message,
        ...(details && { details }), // Only include details if provided
        timestamp: new Date().toISOString(),
    });
}

export function sendAck(res: Response, context: BecknContext) {
    return res.status(200).json({
        context: context,
        message: {
            ack: {
                status: 'ACK',
            },
        },
    });
}

export function sendNack(
    res: Response,
    context: BecknContext,
    errorCode: OndcErrorCodeKey,
    message?: string
) {
    if (res.headersSent) {
        resUtilsLogger.warning(
            'Attempted to send NACK after headers were sent'
        );
        return res;
    }

    const errorMeta = ONDC_ERROR_CODES[errorCode];
    return res.status(200).json({
        context: context,
        message: {
            ack: {
                status: 'NACK',
            },
        },
        error: {
            type: errorMeta.type,
            code: errorCode,
            message: message ?? errorMeta.message,
        },
    });
}
