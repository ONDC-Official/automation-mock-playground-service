import pino from 'pino';
import build from 'pino-loki';
import type { DestinationStream } from 'pino';

export function getPinoConfig(serviceName: string): pino.LoggerOptions {
    const isProduction = process.env.NODE_ENV === 'production';

    return {
        level: process.env.LOG_LEVEL || 'info',
        base: {
            service: serviceName,
            category: 'playground-mock',
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        ...(isProduction
            ? {
                  // In production, we want to log in JSON format for better parsing in Loki
              }
            : {
                  transport: {
                      target: 'pino-pretty',
                      options: {
                          colorize: true,
                          translateTime: 'yyyy-mm-dd HH:MM:ss.l',
                          ignore: 'pid,hostname',
                          messageFormat: '{scope} {msg}',
                      },
                  },
              }),
    };
}

export function getPinoTransports(): DestinationStream | undefined {
    const isProduction = process.env.NODE_ENV === 'production';

    if (!isProduction) {
        return undefined;
    }

    const streams: pino.StreamEntry[] = [];

    // Add Loki transport in production
    if (process.env.LOKI_HOST) {
        try {
            const lokiUsername = process.env.LOKI_USERNAME;
            const lokiPassword = process.env.LOKI_PASSWORD;

            const lokiStream = build({
                host: process.env.LOKI_HOST,
                basicAuth:
                    process.env.LOKI_BASIC_AUTH && lokiUsername && lokiPassword
                        ? {
                              username: lokiUsername,
                              password: lokiPassword,
                          }
                        : undefined,
                labels: { service: 'ondc-playground-mock' },
            });

            streams.push({
                stream: lokiStream,
            });
        } catch (error) {
            console.error('Failed to setup Loki transport:', error);
        }
    }

    // If no custom streams (Loki), return undefined to use default stdout
    if (streams.length === 0) {
        return undefined;
    }

    // Add stdout along with other streams
    streams.push({
        stream: process.stdout,
    });

    return pino.multistream(streams);
}
