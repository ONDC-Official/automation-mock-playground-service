# Queue Service Documentation

This directory contains queue service implementations for handling background jobs in the application.

## Available Implementations

### 1. InMemoryQueue (Development)
A simple in-memory queue implementation suitable for development and testing.

### 2. RabbitMQ (Production)
A production-ready RabbitMQ implementation with advanced features like retries, dead-letter queues, and distributed processing.

## Usage

### Setup

#### Option 1: Using InMemoryQueue (Development)

```typescript
import { createInMemoryQueue } from './queue/InMemoryQueue';

const queueService = createInMemoryQueue();
```

#### Option 2: Using RabbitMQ (Production)

First, ensure RabbitMQ is running:

```bash
# Using Docker
docker run -d --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3-management

# Or using Homebrew (macOS)
brew install rabbitmq
brew services start rabbitmq
```

Then in your code:

```typescript
import { createRabbitMQQueue } from './queue/RabbitMQ';

const queueService = await createRabbitMQQueue({
    url: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    prefetchCount: 10,        // Number of concurrent jobs per worker
    heartbeat: 60,            // Connection heartbeat in seconds
});
```

### Basic Operations

#### 1. Register a Job Handler

Define how jobs should be processed:

```typescript
// Register a handler for 'send-email' jobs
queueService.process<EmailData>('send-email', async (data) => {
    console.log(`Sending email to ${data.to}`);
    await sendEmail(data.to, data.subject, data.body);
    return { sent: true };
});

// Register a handler for 'process-payment' jobs
queueService.process<PaymentData>('process-payment', async (data) => {
    const result = await processPayment(data);
    return result;
});
```

#### 2. Enqueue Jobs

Add jobs to the queue:

```typescript
// Simple enqueue
const jobId = await queueService.enqueue('send-email', {
    to: 'user@example.com',
    subject: 'Welcome!',
    body: 'Thanks for signing up',
});

console.log(`Job enqueued with ID: ${jobId}`);
```

#### 3. Enqueue with Options

Configure retries, backoff, and timeouts:

```typescript
// With retry options
await queueService.enqueue(
    'process-payment',
    { amount: 100, currency: 'USD' },
    {
        attempts: 3,                    // Retry up to 3 times
        backoff: {
            type: 'exponential',        // or 'fixed'
            delay: 1000,                // Initial delay: 1 second
        },
        timeout: 30000,                 // Job timeout: 30 seconds
    }
);
```

#### Backoff Strategies

- **Fixed**: Retry after a constant delay
  ```typescript
  backoff: { type: 'fixed', delay: 5000 }  // Always wait 5 seconds
  ```

- **Exponential**: Delay increases exponentially
  ```typescript
  backoff: { type: 'exponential', delay: 1000 }
  // Attempt 1: 1s, Attempt 2: 2s, Attempt 3: 4s, Attempt 4: 8s...
  ```

#### 4. Listen to Events

Track job completion and failures:

```typescript
// Listen for successful completions
queueService.on('completed', (job, result) => {
    console.log(`Job ${job.id} completed:`, result);
});

// Listen for failures
queueService.on('failed', (job, result, error) => {
    console.error(`Job ${job.id} failed after all retries:`, error);
    // Send alert, log to monitoring service, etc.
});
```

### Complete Example

```typescript
import { createRabbitMQQueue } from './queue/RabbitMQ';

interface EmailJob {
    to: string;
    subject: string;
    body: string;
}

async function setupQueue() {
    // Initialize queue
    const queue = await createRabbitMQQueue({
        url: 'amqp://localhost:5672',
        prefetchCount: 5,
    });

    // Register handler
    queue.process<EmailJob>('send-email', async (data) => {
        console.log(`Processing email to ${data.to}`);
        // Simulate email sending
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (Math.random() < 0.1) {
            throw new Error('Email service unavailable');
        }
        
        return { messageId: 'msg-123', sent: true };
    });

    // Listen for events
    queue.on('completed', (job, result) => {
        console.log(`✓ Email sent successfully:`, result);
    });

    queue.on('failed', (job, _, error) => {
        console.error(`✗ Email failed:`, error.message);
    });

    // Enqueue jobs
    const jobId = await queue.enqueue(
        'send-email',
        {
            to: 'user@example.com',
            subject: 'Welcome!',
            body: 'Hello World',
        },
        {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            timeout: 10000,
        }
    );

    console.log(`Enqueued job: ${jobId}`);
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down queue...');
    await queue.close();
    process.exit(0);
});

setupQueue();
```

## RabbitMQ Features

### Architecture

The RabbitMQ implementation uses:

- **Main Exchange** (`job_exchange`): Routes jobs to appropriate queues
- **Retry Exchange** (`job_retry_exchange`): Handles delayed retries with TTL
- **Dead Letter Exchange** (`job_dlx`): Captures permanently failed jobs

### Queue Structure

For each job type (e.g., `send-email`):

```
send-email              → Main queue for processing
send-email_dlq          → Dead letter queue (failed jobs)
send-email_retry_1000   → Retry queue with 1s delay
send-email_retry_2000   → Retry queue with 2s delay
```

### Retry Flow

1. Job fails → Check attempts remaining
2. If retries left → Send to retry queue with delay
3. After delay → Job returns to main queue
4. If no retries left → Send to dead letter queue

### Monitoring

Access RabbitMQ Management UI:

```
URL: http://localhost:15672
Username: guest
Password: guest
```

View:
- Queue depths
- Message rates
- Failed jobs in DLQ
- Consumer status

### Dead Letter Queue (DLQ)

Jobs that fail after all retries are moved to `{jobName}_dlq`. You can:

1. **Inspect failed jobs** in RabbitMQ Management UI
2. **Manually reprocess** by moving messages back to main queue
3. **Archive/delete** after investigation

### Production Considerations

#### Environment Variables

```bash
RABBITMQ_URL=amqp://username:password@rabbitmq-host:5672
RABBITMQ_PREFETCH=10
RABBITMQ_HEARTBEAT=60
```

#### Connection Resilience

The implementation handles:
- ✓ Automatic connection recovery
- ✓ Channel error handling
- ✓ Graceful shutdown
- ✓ Backpressure (drain events)

#### Scaling

- Run multiple instances for parallel processing
- Each instance consumes from the same queues
- RabbitMQ distributes jobs across consumers

#### Message Durability

- ✓ Durable exchanges and queues
- ✓ Persistent messages
- Messages survive RabbitMQ restarts

## Migration from InMemoryQueue to RabbitMQ

1. **Update initialization**:
   ```typescript
   // Before
   const queue = createInMemoryQueue();
   
   // After
   const queue = await createRabbitMQQueue({
       url: process.env.RABBITMQ_URL || 'amqp://localhost:5672'
   });
   ```

2. **No changes needed** for:
   - `process()` calls
   - `enqueue()` calls
   - Event listeners
   - Job handlers

3. **Test thoroughly** with retry scenarios

## Troubleshooting

### Jobs not processing

- Check RabbitMQ is running: `rabbitmq-diagnostics ping`
- Verify connection URL is correct
- Check for handler registration before enqueuing

### Jobs failing silently

- Add event listeners for `failed` events
- Check RabbitMQ logs
- Inspect DLQ in management UI

### Connection errors

- Verify network connectivity
- Check credentials
- Ensure RabbitMQ is accepting connections on port 5672

### High memory usage

- Reduce `prefetchCount`
- Process jobs faster
- Check for job handler memory leaks

## API Reference

### IQueueService Interface

```typescript
interface IQueueService {
    // Register a job handler
    process<T>(jobName: string, handler: (data: T) => Promise<unknown>): void;
    
    // Enqueue a job
    enqueue<T>(jobName: string, data: T, options?: QueueOptions): Promise<string>;
    
    // Listen for events
    on<T>(event: 'completed' | 'failed', handler: JobEventHandler<T>): void;
    
    // Gracefully close connections
    close(): Promise<void>;
}
```

### QueueOptions

```typescript
interface QueueOptions {
    attempts?: number;           // Number of retry attempts (default: 1)
    backoff?: {
        type: 'fixed' | 'exponential';
        delay: number;           // Initial delay in milliseconds
    };
    timeout?: number;            // Job timeout in milliseconds
}
```

### JobEventHandler

```typescript
type JobEventHandler<T> = (
    job: QueueJob<T>,
    result?: unknown,
    error?: Error
) => void;
```

## Best Practices

1. **Always use retries** for network-dependent operations
2. **Set appropriate timeouts** to prevent hanging jobs
3. **Use exponential backoff** for external API calls
4. **Monitor DLQ** regularly and investigate failures
5. **Handle errors gracefully** in job handlers
6. **Log comprehensively** for debugging
7. **Test failure scenarios** before production
8. **Use meaningful job names** (e.g., `send-welcome-email` not `job1`)
9. **Keep job data serializable** (no functions, classes)
10. **Implement graceful shutdown** with `queue.close()`

## License

MIT
