import type { TraceContext } from '../observability/trace-context';

export interface QueueJob<T> {
    jobName: string;
    id: string;
    data: T;
    timestamp: Date;
    /**
     * Trace envelope captured at enqueue time. Carries the originating request's
     * transaction_id/session_id/domain/version into the (async, possibly
     * cross-process) consumer so job logs remain traceable. For RabbitMQ it
     * rides inside the JSON-serialized message and survives retries/DLQ.
     */
    trace?: TraceContext;
}

export interface QueueOptions {
    attempts?: number;
    backoff?: {
        type: 'fixed' | 'exponential';
        delay: number;
    };
    timeout?: number;
}

export type JobHandler<T> = (data: T) => Promise<unknown>;

export type JobEventHandler<T> = (
    job: QueueJob<T>,
    result?: unknown,
    error?: Error
) => void;

export interface IQueueService {
    process<T>(jobName: string, handler: (data: T) => Promise<unknown>): void;
    enqueue<T>(
        jobName: string,
        data: T,
        options?: QueueOptions
    ): Promise<string>;
    on<T>(
        event: 'completed' | 'failed',
        jobName: string,
        handler: JobEventHandler<T>
    ): void;
    close(): Promise<void>;
}
