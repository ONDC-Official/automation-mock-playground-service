import {
    IQueueService,
    JobEventHandler,
    QueueJob,
    QueueOptions,
} from './IQueueService';
import logger from '../observability/log';
import { randomUUID } from 'crypto';
import { setImmediate } from 'timers';
import { run, snapshot } from '../observability/trace-context';
import {
    mockJobsEnqueuedTotal,
    mockJobsCompletedTotal,
    mockJobsFailedTotal,
    mockJobDuration,
    mockQueueDepth,
} from '../observability/metrics';

const QUEUE_LABEL = 'in-memory';

interface QueuedJob<T> extends QueueJob<T> {
    options?: QueueOptions;
    jobName: string;
    attemptsLeft: number;
}

interface QueueState {
    queue: QueuedJob<unknown>[];
    processing: boolean;
    handlers: Map<string, (data: unknown) => Promise<unknown>>;
    eventHandlers: {
        completed: Map<string, JobEventHandler<unknown>[]>;
        failed: Map<string, JobEventHandler<unknown>[]>;
    };
    processingLoop: NodeJS.Timeout | null;
}

const createQueueState = (): QueueState => ({
    queue: [],
    processing: false,
    handlers: new Map(),
    eventHandlers: {
        completed: new Map(),
        failed: new Map(),
    },
    processingLoop: null,
});

const generateJobId = (jobName: string): string =>
    `${jobName}_${Date.now()}_${randomUUID()}`;

const createJob = <T>(
    jobName: string,
    data: T,
    options?: QueueOptions
): QueuedJob<T> => ({
    id: generateJobId(jobName),
    data,
    timestamp: new Date(),
    jobName,
    options,
    attemptsLeft: options?.attempts || 1,
    trace: snapshot(),
});

const withTimeout = async <T>(
    promise: Promise<T>,
    timeout: number
): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error('Job timed out')), timeout)
        ),
    ]);
};

const calculateRetryDelay = (
    option: QueueOptions,
    attemptNumber: number
): number => {
    if (!option.backoff) return 1000;
    if (option.backoff.type === 'exponential') {
        return option.backoff.delay * Math.pow(2, attemptNumber - 1);
    } else {
        return option.backoff.delay;
    }
};

const emitEvent = <T>(
    state: QueueState,
    eventType: 'completed' | 'failed',
    job: QueueJob<T> & { jobName: string },
    result?: unknown,
    error?: Error
): void => {
    const handlers = state.eventHandlers[eventType].get(job.jobName) || [];

    handlers.forEach(handler => {
        try {
            handler(job, result, error);
        } catch (err) {
            logger.error(
                `Error in ${eventType} event handler for job ${job.id}: ${
                    (err as Error).message
                }`
            );
        }
    });
};

const scheduleProcessing = (state: QueueState): void => {
    if (!state.processing && state.queue.length > 0) {
        // Use setImmediate for immediate processing on next tick
        setImmediate(() => processNextJob(state));
    }
};

const processNextJob = async (state: QueueState): Promise<void> => {
    if (state.processing || state.queue.length === 0) return;
    state.processing = true;
    const job = state.queue.shift()!;
    mockQueueDepth.set({ queue: QUEUE_LABEL }, state.queue.length);
    const handler = state.handlers.get(job.jobName);

    if (!handler) {
        logger.error(`No handler registered for job: ${job.jobName}`);
        state.processing = false;
        scheduleProcessing(state); // ✅ Process next job
        return;
    }

    // Re-establish the originating request's trace context for the duration of
    // the handler and its completed/failed event handlers, so job logs carry
    // the same transaction_id/session_id/domain/version.
    try {
        await run(job.trace ?? {}, async () => {
            const endTimer = mockJobDuration.startTimer({
                job_name: job.jobName,
            });
            try {
                const result = job.options?.timeout
                    ? await withTimeout(handler(job.data), job.options.timeout)
                    : await handler(job.data);

                endTimer({ result: 'success' });
                mockJobsCompletedTotal.inc({ job_name: job.jobName });
                emitEvent(state, 'completed', job, result);
                logger.info(`Job ${job.id} completed successfully.`);
            } catch (error) {
                logger.error(
                    `Job ${job.id} failed`,
                    {
                        event: 'job_failed',
                        job_name: job.jobName,
                        job_id: job.id,
                        attempts_left: job.attemptsLeft - 1,
                    },
                    error
                );
                job.attemptsLeft -= 1;

                if (job.attemptsLeft > 0) {
                    endTimer({ result: 'retry' });
                    const delay = calculateRetryDelay(
                        job.options || {},
                        (job.options?.attempts || 1) - job.attemptsLeft
                    );
                    logger.info(
                        `Re-enqueuing job ${job.id} after ${delay}ms, attempts left: ${job.attemptsLeft}`
                    );
                    setTimeout(() => {
                        state.queue.push(job);
                        mockQueueDepth.set(
                            { queue: QUEUE_LABEL },
                            state.queue.length
                        );
                        scheduleProcessing(state); // ✅ Trigger processing after retry
                    }, delay);
                } else {
                    endTimer({ result: 'failure' });
                    mockJobsFailedTotal.inc({ job_name: job.jobName });
                    emitEvent(state, 'failed', job, undefined, error as Error);
                }
            }
        });
    } finally {
        state.processing = false;
        scheduleProcessing(state); // ✅ Process next job
    }
};

export const createInMemoryQueue = (): IQueueService => {
    const state = createQueueState();

    state.processingLoop = setInterval(() => {
        scheduleProcessing(state);
    }, 100);

    return {
        process<T>(
            jobName: string,
            handler: (data: T) => Promise<unknown>
        ): void {
            state.handlers.set(
                jobName,
                handler as (data: unknown) => Promise<unknown>
            );
        },

        async enqueue<T>(
            jobName: string,
            data: T,
            options?: QueueOptions
        ): Promise<string> {
            const job = createJob(jobName, data, options);
            state.queue.push(job);
            mockJobsEnqueuedTotal.inc({ job_name: jobName });
            mockQueueDepth.set({ queue: QUEUE_LABEL }, state.queue.length);
            logger.info(`Enqueued job ${job.id} of type ${jobName}`);
            scheduleProcessing(state); // ✅ Trigger processing immediately
            return job.id;
        },

        on<T>(
            event: 'completed' | 'failed',
            jobName: string,
            handler: JobEventHandler<T>
        ): void {
            const handlersMap = state.eventHandlers[event];
            const existingHandlers = handlersMap.get(jobName) || [];
            existingHandlers.push(handler as JobEventHandler<unknown>);
            handlersMap.set(jobName, existingHandlers);
        },

        async close(): Promise<void> {
            if (state.processingLoop) {
                clearInterval(state.processingLoop);
                state.processingLoop = null;
            }
            state.queue = [];
            state.processing = false;
            state.handlers.clear();
            state.eventHandlers.completed.clear();
            state.eventHandlers.failed.clear();
        },
    };
};

export type queueServiceType = ReturnType<typeof createInMemoryQueue>;
