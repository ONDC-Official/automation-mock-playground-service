import { Response } from 'express';
import { sendSuccess, sendError, sendAck, sendNack } from './res-utils';
import { ERROR_CODES, ONDC_ERROR_CODES } from '../constants/error-codes';
import { BecknContext } from '../types/ondc-types';

// Mock logger
jest.mock('../utils/logger', () => ({
    child: jest.fn(() => ({
        warning: jest.fn(),
        error: jest.fn(),
    })),
}));

describe('res-utils', () => {
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        mockJson = jest.fn().mockReturnThis();
        mockStatus = jest.fn().mockReturnThis();

        mockResponse = {
            json: mockJson,
            status: mockStatus,
            headersSent: false,
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('sendSuccess', () => {
        it('should send success response with custom message and status code', () => {
            const testData = { id: 1 };
            const customMessage = 'User created successfully';
            const customStatus = 201;

            sendSuccess(
                mockResponse as Response,
                testData,
                false,
                customMessage,
                customStatus
            );

            expect(mockStatus).toHaveBeenCalledWith(201);
            expect(mockJson).toHaveBeenCalledWith({
                success: true,
                data: testData,
                message: customMessage,
                timestamp: expect.any(String),
            });
        });

        it('should handle null/undefined data', () => {
            sendSuccess(mockResponse as Response, null, false);
            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith({
                success: true,
                data: null,
                message: 'OK',
                timestamp: expect.any(String),
            });
        });

        it('should not send response if headers already sent', () => {
            mockResponse.headersSent = true;

            const result = sendSuccess(
                mockResponse as Response,
                {
                    test: true,
                },
                false
            );

            expect(mockStatus).not.toHaveBeenCalled();
            expect(mockJson).not.toHaveBeenCalled();
            expect(result).toBe(mockResponse);
        });

        it('should return proper TypeScript types', () => {
            const result = sendSuccess(mockResponse as Response, { id: 1 });
            // TypeScript compilation test - should not have type errors
            expect(result).toBeDefined();
        });
    });

    describe('sendError', () => {
        it('should send error response with valid error code', () => {
            const errorCode = 'INTERNAL_ERROR';
            const expectedError = ERROR_CODES[errorCode];

            sendError(mockResponse as Response, errorCode);

            expect(mockStatus).toHaveBeenCalledWith(expectedError.httpStatus);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: expectedError.code,
                message: expectedError.message,
                timestamp: expect.any(String),
            });
        });

        it('should send error response with custom message', () => {
            const errorCode = 'INTERNAL_ERROR';
            const customMessage = 'Custom validation failed';
            const expectedError = ERROR_CODES[errorCode];

            sendError(mockResponse as Response, errorCode, customMessage);

            expect(mockStatus).toHaveBeenCalledWith(expectedError.httpStatus);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: expectedError.code,
                message: customMessage,
                timestamp: expect.any(String),
            });
        });

        it('should send error response with details', () => {
            const errorCode = 'TOO_MANY_REQUESTS';
            const customMessage = 'Validation failed';
            const details = { field: 'email', reason: 'invalid format' };
            const expectedError = ERROR_CODES[errorCode];

            sendError(
                mockResponse as Response,
                errorCode,
                customMessage,
                details
            );

            expect(mockStatus).toHaveBeenCalledWith(expectedError.httpStatus);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: expectedError.code,
                message: customMessage,
                details,
                timestamp: expect.any(String),
            });
        });

        it('should handle invalid error code gracefully', () => {
            const invalidErrorCode = 'INVALID_ERROR_CODE' as any;

            sendError(mockResponse as Response, invalidErrorCode);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: 'INTERNAL_SERVER_ERROR',
                message: 'An unexpected error occurred.',
                timestamp: expect.any(String),
            });
        });

        it('should use custom message when error code is invalid', () => {
            const invalidErrorCode = 'INVALID_ERROR_CODE' as any;
            const customMessage = 'Custom error message';

            sendError(
                mockResponse as Response,
                invalidErrorCode,
                customMessage
            );

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: 'INTERNAL_SERVER_ERROR',
                message: customMessage,
                timestamp: expect.any(String),
            });
        });

        it('should not send response if headers already sent', () => {
            mockResponse.headersSent = true;

            const result = sendError(
                mockResponse as Response,
                'INTERNAL_ERROR'
            );

            expect(mockStatus).not.toHaveBeenCalled();
            expect(mockJson).not.toHaveBeenCalled();
            expect(result).toBe(mockResponse);
        });

        it('should not include details if not provided', () => {
            const errorCode = 'HEALTH_CHECK_FAILED';
            const expectedError = ERROR_CODES[errorCode];

            sendError(mockResponse as Response, errorCode);

            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                errorCode: expectedError.code,
                message: expectedError.message,
                timestamp: expect.any(String),
            });

            const callArgs = mockJson.mock.calls[0][0];
            expect(callArgs).not.toHaveProperty('details');
        });
    });

    describe('sendAck', () => {
        it('should send ACK response with context', () => {
            const context: BecknContext = {
                domain: 'test-domain',
                country: 'IND',
                city: 'std:080',
                action: 'search',
                core_version: '1.2.0',
                bap_id: 'test-bap',
                bap_uri: 'https://test-bap.com',
                bpp_id: 'test-bpp',
                bpp_uri: 'https://test-bpp.com',
                transaction_id: 'txn-123',
                message_id: 'msg-123',
                timestamp: '2023-01-01T00:00:00.000Z',
            };

            sendAck(mockResponse as Response, context);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith({
                context: context,
                message: {
                    ack: {
                        status: 'ACK',
                    },
                },
            });
        });

        it('should handle empty context object', () => {
            const emptyContext = {} as BecknContext;

            sendAck(mockResponse as Response, emptyContext);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith({
                context: emptyContext,
                message: {
                    ack: {
                        status: 'ACK',
                    },
                },
            });
        });
    });

    describe('sendNack', () => {
        it('should send NACK response with error details', () => {
            const context: BecknContext = {
                domain: 'test-domain',
                country: 'IND',
                city: 'std:080',
                action: 'search',
                core_version: '1.2.0',
                bap_id: 'test-bap',
                bap_uri: 'https://test-bap.com',
                transaction_id: 'txn-123',
                message_id: 'msg-123',
                timestamp: '2023-01-01T00:00:00.000Z',
            };
            const errorCode = '10001';
            const expectedError = ONDC_ERROR_CODES[errorCode];

            sendNack(mockResponse as Response, context, errorCode);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith({
                context: context,
                message: {
                    ack: {
                        status: 'NACK',
                    },
                },
                error: {
                    type: expectedError.type,
                    code: errorCode,
                    message: expectedError.message,
                },
            });
        });

        it('should not send response if headers already sent', () => {
            mockResponse.headersSent = true;
            const context = {} as BecknContext;

            const result = sendNack(mockResponse as Response, context, '10001');

            expect(mockStatus).not.toHaveBeenCalled();
            expect(mockJson).not.toHaveBeenCalled();
            expect(result).toBe(mockResponse);
        });

        it('should handle different ONDC error codes', () => {
            const context = {} as BecknContext;
            const errorCode = '20001';
            const expectedError = ONDC_ERROR_CODES[errorCode];

            sendNack(mockResponse as Response, context, errorCode);

            expect(mockJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: {
                        type: expectedError.type,
                        code: errorCode,
                        message: expectedError.message,
                    },
                })
            );
        });
    });

    describe('Type Safety Tests', () => {
        it('should maintain proper TypeScript types for SuccessResponse', () => {
            interface User {
                id: number;
                name: string;
            }

            const user: User = { id: 1, name: 'John' };
            sendSuccess<User>(mockResponse as Response, user, false);

            // TypeScript compilation check - should not have errors
            expect(mockJson).toHaveBeenCalledWith({
                success: true,
                data: user,
                message: 'OK',
                timestamp: expect.any(String),
            });
        });

        it('should maintain proper TypeScript types for ErrorResponse', () => {
            const details = { field: 'email', reason: 'required' };
            sendError(
                mockResponse as Response,
                'TOO_MANY_REQUESTS',
                'Custom message',
                details
            );

            // TypeScript compilation check - should not have errors
            expect(mockJson).toHaveBeenCalled();
        });
    });

    describe('Edge Cases', () => {
        it('should handle concurrent calls with headers already sent', () => {
            // Simulate first call succeeding
            sendSuccess(mockResponse as Response, { test: 'data' });
            expect(mockStatus).toHaveBeenCalledTimes(1);

            // Simulate headers being sent
            mockResponse.headersSent = true;

            // Second call should be ignored
            sendSuccess(mockResponse as Response, { test: 'data2' });
            sendError(mockResponse as Response, 'INTERNAL_ERROR');

            // Status should only be called once (from first call)
            expect(mockStatus).toHaveBeenCalledTimes(1);
        });

        it('should handle undefined details gracefully', () => {
            sendError(
                mockResponse as Response,
                'INTERNAL_ERROR',
                'Test message',
                undefined
            );

            const callArgs = mockJson.mock.calls[0][0];
            expect(callArgs).not.toHaveProperty('details');
        });

        it('should generate valid ISO timestamp', () => {
            sendSuccess(mockResponse as Response, { test: true }, false);

            const callArgs = mockJson.mock.calls[0][0];
            const timestamp = callArgs.timestamp;

            expect(timestamp).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
            );
            expect(new Date(timestamp).toISOString()).toBe(timestamp);
        });
    });
});
