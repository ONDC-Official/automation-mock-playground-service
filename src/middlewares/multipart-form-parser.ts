import { NextFunction, Request, Response } from 'express';
import logger from '@ondc/automation-logger';

const MAX_BODY_SIZE = 3 * 1024 * 1024; // matches express.json limit in server.ts

const parseMultipart = (
    body: Buffer,
    boundary: string
): Record<string, string> => {
    const fields: Record<string, string> = {};
    const boundaryBuffer = Buffer.from(`--${boundary}`);

    let start = body.indexOf(boundaryBuffer);
    while (start !== -1) {
        const next = body.indexOf(
            boundaryBuffer,
            start + boundaryBuffer.length
        );
        if (next === -1) break;

        const part = body.subarray(start + boundaryBuffer.length, next);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
            const rawHeaders = part.subarray(0, headerEnd).toString('utf-8');
            let content = part.subarray(headerEnd + 4);
            if (content.subarray(-2).toString() === '\r\n') {
                content = content.subarray(0, -2);
            }

            const nameMatch = rawHeaders.match(/name="([^"]*)"/);
            const filenameMatch = rawHeaders.match(/filename="([^"]*)"/);

            if (nameMatch && !filenameMatch) {
                fields[nameMatch[1]] = content.toString('utf-8');
            } else if (nameMatch && filenameMatch) {
                logger.warning(
                    'multipartFormParser: ignoring file field, only text fields are supported',
                    { field: nameMatch[1], filename: filenameMatch[1] }
                );
            }
        }
        start = next;
    }

    return fields;
};

/**
 * Lightweight multipart/form-data parser for text-only fields (no file uploads).
 * Populates req.body the same way express.urlencoded()/express.json() do for other content types.
 */
export const multipartFormParser = (
    req: Request
    _res: Response,
    next: NextFunction
) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
        return next();
    }

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
    if (!boundary) {
        return next(new Error('Missing multipart boundary in Content-Type'));
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
            aborted = true;
            next(new Error('Multipart body exceeds size limit'));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        if (aborted) return;
        try {
            req.body = parseMultipart(Buffer.concat(chunks), boundary);
            next();
        } catch (error) {
            next(error);
        }
    });

    req.on('error', (error) => {
        if (aborted) return;
        aborted = true;
        next(error);
    });
};
