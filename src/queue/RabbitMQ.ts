import amqplib, { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import {
    IQueueService,
    JobEventHandler,
    QueueJob,
    QueueOptions,
} from './IQueueService';
import logger from '../utils/logger';
import { randomUUID } from 'crypto';

interface RabbitMQConfig {
    url: string;
    prefetchCount?: number;
    heartbeat?: number;
}

interface QueuedJob<T> extends QueueJob<T> {
    options?: QueueOptions;
    jobName: string;
    attemptsLeft: number;
}

interface RabbitMQState {
    connection: ChannelModel | null;
    channel: Channel | null;
    handlers: Map<string, (data: unknown) => Promise<unknown>>;
    eventHandlers: {
        completed: Array<JobEventHandler<unknown>>;
        failed: Array<JobEventHandler<unknown>>;
    };
    isConnected: boolean;
    consumerTags: Map<string, string>;
}

const EXCHANGE_NAME = 'job_exchange';
const DEAD_LETTER_EXCHANGE = 'job_dlx';
const RETRY_EXCHANGE = 'job_retry_exchange';

const createRabbitMQState = (): RabbitMQState => ({
    connection: null,
    channel: null,
    handlers: new Map(),
    eventHandlers: {
        completed: [],
        failed: [],
    },
    isConnected: false,
    consumerTags: new Map(),
});

const generateJobId = (jobName: string): string =>
    `${jobName}_${Date.now()}_${randomUUID()}`;

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
    }
    return option.backoff.delay;
};

const emitEvent = (
    state: RabbitMQState,
    eventType: 'completed' | 'failed',
    job: QueueJob<unknown>,
    result?: unknown,
    error?: Error
): void => {
    state.eventHandlers[eventType].forEach(handler => {
        try {
            handler(job, result, error);
        } catch (err) {
            logger.error(
                `Error in ${eventType} event handler for job ${job.id}`,
                {},
                err
            );
        }
    });
};

const setupExchangesAndQueues = async (
    channel: Channel,
    queueName: string
): Promise<void> => {
    // Create main exchanges
    await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', {
        durable: true,
    });
    await channel.assertExchange(RETRY_EXCHANGE, 'direct', { durable: true });

    // Create main queue
    await channel.assertQueue(queueName, {
        durable: true,
        deadLetterExchange: DEAD_LETTER_EXCHANGE,
    });

    // Create dead letter queue
    const dlqName = `${queueName}_dlq`;
    await channel.assertQueue(dlqName, { durable: true });

    // Bind queues
    await channel.bindQueue(queueName, EXCHANGE_NAME, queueName);
    await channel.bindQueue(dlqName, DEAD_LETTER_EXCHANGE, queueName);
};

const setupRetryQueue = async (
    channel: Channel,
    queueName: string,
    delay: number
): Promise<string> => {
    const retryQueueName = `${queueName}_retry_${delay}`;

    await channel.assertQueue(retryQueueName, {
        durable: true,
        deadLetterExchange: EXCHANGE_NAME,
        deadLetterRoutingKey: queueName,
        messageTtl: delay,
    });

    await channel.bindQueue(retryQueueName, RETRY_EXCHANGE, retryQueueName);

    return retryQueueName;
};

const parseJobMessage = <T>(content: Buffer): QueuedJob<T> | null => {
    try {
        return JSON.parse(content.toString()) as QueuedJob<T>;
    } catch (error) {
        logger.error('Failed to parse job message', {}, error);
        return null;
    }
};

const processMessage = async (
    state: RabbitMQState,
    msg: ConsumeMessage,
    jobName: string
): Promise<void> => {
    if (!state.channel) {
        logger.error('Channel not available for processing message');
        return;
    }

    const job = parseJobMessage<unknown>(msg.content);

    if (!job) {
        logger.error('Invalid job message format');
        state.channel.nack(msg, false, false);
        return;
    }

    try {
        const handler = state.handlers.get(jobName);

        if (!handler) {
            logger.error(`No handler registered for job: ${jobName}`);
            state.channel.nack(msg, false, false);
            return;
        }

        logger.info(`Processing job ${job.id} of type ${jobName}`);

        const result = job.options?.timeout
            ? await withTimeout(handler(job.data), job.options.timeout)
            : await handler(job.data);

        emitEvent(state, 'completed', job, result);
        state.channel.ack(msg);
        logger.info(`Job ${job.id} completed successfully`);
    } catch (error) {
        logger.error(`Job ${job.id} failed`, {}, error);

        job.attemptsLeft -= 1;

        if (job.attemptsLeft > 0 && state.channel) {
            const attemptNumber =
                (job.options?.attempts || 1) - job.attemptsLeft;
            const delay = calculateRetryDelay(job.options || {}, attemptNumber);

            logger.info(
                `Re-enqueuing job ${job.id} after ${delay}ms, attempts left: ${job.attemptsLeft}`
            );

            // Create or use existing retry queue
            const retryQueueName = await setupRetryQueue(
                state.channel,
                jobName,
                delay
            );

            // Publish to retry queue
            state.channel.publish(
                RETRY_EXCHANGE,
                retryQueueName,
                Buffer.from(JSON.stringify(job)),
                { persistent: true }
            );

            state.channel.ack(msg);
        } else {
            // Max retries exceeded
            emitEvent(state, 'failed', job, undefined, error as Error);
            state.channel?.nack(msg, false, false); // Send to DLQ
        }
    }
};

const connectToRabbitMQ = async (
    state: RabbitMQState,
    config: RabbitMQConfig
): Promise<void> => {
    try {
        const connection = await amqplib.connect(config.url, {
            heartbeat: config.heartbeat || 60,
        });

        state.connection = connection;

        connection.on('error', (err: Error) => {
            logger.error('RabbitMQ connection error', {}, err);
            state.isConnected = false;
        });

        connection.on('close', () => {
            logger.info('RabbitMQ connection closed');
            state.isConnected = false;
        });

        const channel = await connection.createChannel();
        state.channel = channel;

        channel.prefetch(config.prefetchCount || 10);

        channel.on('error', (err: Error) => {
            logger.error('RabbitMQ channel error', {}, err);
        });

        channel.on('close', () => {
            logger.info('RabbitMQ channel closed');
        });

        state.isConnected = true;
        logger.info('Successfully connected to RabbitMQ');
    } catch (error) {
        logger.error('Failed to connect to RabbitMQ', {}, error);
        throw error;
    }
};

export const createRabbitMQQueue = async (
    config: RabbitMQConfig
): Promise<IQueueService> => {
    const state = createRabbitMQState();

    await connectToRabbitMQ(state, config);

    return {
        process<T>(
            jobName: string,
            handler: (data: T) => Promise<unknown>
        ): void {
            if (!state.channel) {
                throw new Error('RabbitMQ channel not initialized');
            }

            state.handlers.set(
                jobName,
                handler as (data: unknown) => Promise<unknown>
            );

            // Setup queue and start consuming
            setupExchangesAndQueues(state.channel, jobName)
                .then(() => {
                    if (!state.channel) return;

                    return state.channel.consume(
                        jobName,
                        (msg: amqplib.ConsumeMessage | null) => {
                            if (msg) {
                                processMessage(state, msg, jobName).catch(
                                    err => {
                                        logger.error(
                                            `Error processing message for job ${jobName}`,
                                            {},
                                            err
                                        );
                                    }
                                );
                            }
                        },
                        { noAck: false }
                    );
                })
                .then(consumeResult => {
                    if (consumeResult) {
                        state.consumerTags.set(
                            jobName,
                            consumeResult.consumerTag
                        );
                        logger.info(
                            `Started consuming messages for job type: ${jobName}`
                        );
                    }
                })
                .catch(err => {
                    logger.error(
                        `Failed to setup consumer for ${jobName}`,
                        {},
                        err
                    );
                });
        },

        async enqueue<T>(
            jobName: string,
            data: T,
            options?: QueueOptions
        ): Promise<string> {
            if (!state.channel || !state.isConnected) {
                throw new Error('RabbitMQ not connected');
            }

            const job: QueuedJob<T> = {
                id: generateJobId(jobName),
                data,
                timestamp: new Date(),
                jobName,
                options,
                attemptsLeft: options?.attempts || 1,
            };

            // Ensure queue exists
            await setupExchangesAndQueues(state.channel, jobName);

            // Publish to main exchange
            const published = state.channel.publish(
                EXCHANGE_NAME,
                jobName,
                Buffer.from(JSON.stringify(job)),
                {
                    persistent: true,
                    messageId: job.id,
                }
            );

            if (!published) {
                logger.info(
                    `Message buffer full, waiting to enqueue job ${job.id}`
                );
                await new Promise<void>(resolve =>
                    state.channel?.once('drain', resolve)
                );
            }

            logger.info(`Enqueued job ${job.id} of type ${jobName}`);
            return job.id;
        },

        on<T>(
            event: 'completed' | 'failed',
            handler: JobEventHandler<T>
        ): void {
            state.eventHandlers[event].push(
                handler as JobEventHandler<unknown>
            );
        },

        async close(): Promise<void> {
            try {
                // Cancel all consumers
                if (state.channel) {
                    for (const [jobName, consumerTag] of state.consumerTags) {
                        try {
                            await state.channel.cancel(consumerTag);
                            logger.info(
                                `Cancelled consumer for job type: ${jobName}`
                            );
                        } catch (err) {
                            logger.error(
                                `Error cancelling consumer for ${jobName}`,
                                {},
                                err
                            );
                        }
                    }
                    await state.channel.close();
                }

                if (state.connection) {
                    await state.connection.close();
                }

                state.isConnected = false;
                state.handlers.clear();
                state.eventHandlers.completed = [];
                state.eventHandlers.failed = [];
                state.consumerTags.clear();

                logger.info('RabbitMQ connection closed successfully');
            } catch (error) {
                logger.error('Error closing RabbitMQ connection', {}, error);
                throw error;
            }
        },
    };
};
// Replace the last line with:
export type RabbitMQServiceType = IQueueService;
