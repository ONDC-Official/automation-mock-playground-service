# ONDC Playground Mock Service

A production-ready TypeScript microservice for simulating ONDC (Open Network for Digital Commerce) protocol flows. This service provides mock endpoints for testing buyer and seller interactions in the ONDC ecosystem.

## 🚀 Features

- **Flow Management**: Create and manage ONDC transaction flows
- **Mock Response Generation**: Automated payload generation for ONDC protocol actions
- **Dual Queue Support**: In-memory queue for development, RabbitMQ for production
- **Redis Caching**: Dual database support for session and configuration management
- **Transaction Tracking**: Complete API lifecycle tracking and status monitoring
- **Schema Validation**: JSON Schema validation with AJV
- **Custom ESLint Rules**: Enforce best practices in response handling
- **Comprehensive Logging**: Structured logging with Pino and Loki integration
- **Health Monitoring**: Built-in health checks and metrics
- **TypeScript**: Full type safety and modern JavaScript features

## 📋 Prerequisites

- **Node.js**: v18+ recommended
- **Redis**: v6+ (for caching)
- **RabbitMQ**: v3+ (optional, for production queue)
- **npm** or **yarn**

## 🛠️ Installation

```bash
# Clone the repository
git clone <repository-url>
cd automation-mock-playground-service

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the root directory:

```bash
# Application
NODE_ENV=development          # development | production
PORT=3000                      # Server port
LOG_LEVEL=info                # Logging level

# External Services
API_SERVICE_URL=http://api-service.local

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=
REDIS_PASSWORD=
REDIS_DB_0=0                  # Workbench cache
REDIS_DB_1=1                  # Config cache

# RabbitMQ Configuration (Production)
RABBITMQ_URL=amqp://localhost:5672
```

### Redis Setup

```bash
# Using Docker
docker run -d --name redis -p 6379:6379 redis:latest

# Using Homebrew (macOS)
brew install redis
brew services start redis
```

### RabbitMQ Setup (Optional - Production)

```bash
# Using Docker
docker run -d --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3-management

# Access management UI at http://localhost:15672
# Default credentials: guest/guest
```

## 🏃 Running the Application

### Development Mode

```bash
npm run dev
```

Uses `nodemon` and `tsx` for hot-reloading during development.

### Production Mode

```bash
# Build TypeScript to JavaScript
npm run build

# Start the production server
npm start
```

### Combined Build + Start

```bash
npm run build && npm start
```

## 📚 API Documentation

### Base URL

```
http://localhost:3000/mock/playground
```

### Core Endpoints

#### 1. Start New Flow

**POST** `/flow/new`

Start a new transaction flow.

**Request Body:**
```json
{
  "session_id": "session-123",
  "flow_id": "buyer-search-flow",
  "transaction_id": "txn-456",  // Optional, auto-generated if not provided
  "inputs": {
    "search_query": "electronics"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transaction_id": "txn-456",
    "status": "started"
  }
}
```

#### 2. Proceed with Flow

**POST** `/flow/proceed`

Continue an existing transaction flow.

**Request Body:**
```json
{
  "session_id": "session-123",
  "transaction_id": "txn-456",
  "inputs": {
    "selected_items": ["item-1", "item-2"]
  }
}
```

#### 3. Get Flow Status

**GET** `/flow/current-status?transaction_id=txn-456&session_id=session-123`

Retrieve the current status and progress of a flow.

**Response:**
```json
{
  "success": true,
  "data": {
    "sequence": [
      {
        "action": "search",
        "status": "completed",
        "timestamp": "2026-02-03T10:00:00Z"
      },
      {
        "action": "on_search",
        "status": "completed",
        "timestamp": "2026-02-03T10:00:01Z"
      },
      {
        "action": "select",
        "status": "pending"
      }
    ],
    "missedSteps": [],
    "reference_data": {}
  }
}
```

#### 4. Manual Action Trigger

**POST** `/manual/:action`

Trigger a specific ONDC action manually.

**Example:**
```bash
POST /mock/playground/manual/search
```

#### 5. Health Check

**GET** `/health`

Check service health status.

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 12345,
    "timestamp": "2026-02-03T10:00:00Z"
  }
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run multi-instance tests
npm run test:multi-instance
```

## 🎨 Code Quality

### Linting

```bash
# Check for linting errors
npm run lint

# Auto-fix linting errors
npm run lint:fix
```

### Formatting

```bash
# Check code formatting
npm run format:check

# Auto-format code
npm run format
```

### Type Checking

```bash
npm run type-check
```

## 🏗️ Architecture

### Project Structure

```
automation-mock-playground-service/
├── src/
│   ├── cache/              # Caching layer (Redis, in-memory)
│   ├── config/             # Configuration management
│   ├── container/          # Dependency injection container
│   ├── controllers/        # Request handlers
│   ├── errors/             # Custom error classes
│   ├── middlewares/        # Express middlewares
│   ├── queue/              # Queue implementations (InMemory, RabbitMQ)
│   ├── routes/             # API route definitions
│   ├── service/            # Business logic
│   │   ├── cache/          # Cache services
│   │   ├── flows/          # Flow processing logic
│   │   └── jobs/           # Background job handlers
│   ├── types/              # TypeScript type definitions
│   ├── utils/              # Utility functions
│   ├── validations/        # Schema validation
│   ├── index.ts            # Application entry point
│   └── server.ts           # Express server setup
├── .env.example            # Environment variables template
├── package.json
├── tsconfig.json
└── README.md
```

### Key Components

#### 1. Service Container

Centralized dependency injection for managing services:

```typescript
const container = ServiceContainer.getInstance();
const queueService = container.getQueueService();
const cacheService = container.getCacheService0();
```

#### 2. Queue Service

Supports both in-memory (development) and RabbitMQ (production):

- **InMemoryQueue**: Simple in-process queue
- **RabbitMQ**: Distributed queue with retries, DLQ, and monitoring

See [Queue Service Documentation](src/queue/README.md) for details.

#### 3. Cache Layer

Two Redis databases for different purposes:
- **DB 0**: Workbench cache (sessions, transactions)
- **DB 1**: Configuration cache (mock runner configs)

#### 4. Flow Processing

Handles ONDC transaction flows:
- Flow initialization
- Step sequencing
- Status tracking
- Missed step detection

## 🔧 Custom ESLint Rules

This project includes custom ESLint rules in `eslint-rules/`:

- **no-direct-response**: Prevents direct use of Express response methods
  - Use `sendSuccess()` and `sendError()` from `res-utils` instead

## 📊 Monitoring

### Logs

Structured JSON logging with Pino:

```typescript
logger.info('Processing request', { transactionId, sessionId });
logger.error('Error occurred', { error }, err);
```

### Metrics

Prometheus-compatible metrics available at `/metrics` (if configured).

### Health Checks

Built-in health monitoring:
- Service availability
- External dependencies status
- Resource utilization

## 🚀 Production Deployment

### Using Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

### Environment-Specific Configurations

- Set `NODE_ENV=production`
- Use RabbitMQ instead of in-memory queue
- Configure proper Redis credentials
- Enable production logging
- Set up monitoring and alerting

### Scaling Considerations

1. **Horizontal Scaling**: Run multiple instances behind a load balancer
2. **Queue Workers**: Scale RabbitMQ consumers independently
3. **Redis**: Use Redis Cluster for high availability
4. **Session Affinity**: Not required (stateless design)

## 🤝 Contributing

1. Follow the existing code style
2. Run linting and tests before committing
3. Use meaningful commit messages
4. Update documentation for new features

## 📝 License

ISC

## 👥 Authors

- **extedcouD** - Initial work

## 🐛 Troubleshooting

### Common Issues

**1. "QueueService not initialized" Error**

Ensure `InitMainContainer()` is called before importing routes.

**2. Redis Connection Failed**

Check Redis is running and credentials are correct in `.env`.

**3. TypeScript Compilation Errors**

Run `npm run type-check` to identify type issues.

**4. Dev Mode Fails but Build Works**

This might be a module loading order issue. Try:
```bash
npm run build && npm start
```

### Getting Help

- Check the [Queue Service README](src/queue/README.md)
- Review ESLint rules in `eslint-rules/`
- Check application logs for detailed error messages

## 🔗 Related Documentation

- [ONDC Protocol Specifications](https://ondc.org)
- [Express.js Documentation](https://expressjs.com)
- [RabbitMQ Guide](https://www.rabbitmq.com/getstarted.html)
- [Redis Documentation](https://redis.io/docs)