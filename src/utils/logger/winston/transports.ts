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
            ? {}
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

    const streams: pino.StreamEntry[] = [
        {
            stream: process.stdout,
        },
    ];

    // Add Loki transport in production
    if (process.env.LOKI_HOST) {
        try {
            const lokiStream = build({
                host: process.env.LOKI_HOST,
                basicAuth: process.env.LOKI_BASIC_AUTH
                    ? {
                          username: process.env.LOKI_USERNAME || '',
                          password: process.env.LOKI_PASSWORD || '',
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

    return pino.multistream(streams);
}
