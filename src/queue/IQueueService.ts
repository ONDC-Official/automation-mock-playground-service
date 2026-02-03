export interface QueueJob<T> {
    jobName: string;
    id: string;
    data: T;
    timestamp: Date;
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
