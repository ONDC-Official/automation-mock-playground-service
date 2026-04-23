# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Hot-reload development server (nodemon + tsx)
npm run type-check   # TypeScript validation without emit

# Code quality
npm run lint         # ESLint check
npm run lint:fix     # Auto-fix linting issues
npm run format       # Prettier formatting

# Testing
npm run test              # Run all tests
npm run test:watch        # Watch mode
npm run test:cov          # With coverage report
npm run test:multi-instance  # E2E multi-instance via docker-compose (see src/test/E2E)

# Production
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output

# Docker
docker-compose up    # Full stack (service + Redis + RabbitMQ)
```

Run a single test file: `npx jest path/to/file.test.ts`. Filter by name: `npx jest -t 'name pattern'`.

## Architecture Overview

This is an ONDC (Open Network for Digital Commerce) playground mock service — a TypeScript/Express microservice that simulates ONDC protocol flows for testing buyer-seller interactions.

### Request Flow

Incoming HTTP requests → validation middleware → controller → service layer → job queue → job handler. Job handlers interact with the cache layer and optionally call external services (API service, config service).

### Key Architectural Patterns

**Dependency Injection Container** (`src/container/implementations/main.ts`): A `ServiceContainer` singleton manages all service instantiation. Services are accessed via this container throughout the codebase rather than imported directly.

**Dual Redis Cache** (`src/cache/`, `src/service/cache/`):
- DB 0 (`WorkbenchCacheService`): Transactional data, sessions, and business state
- DB 1 (`ConfigCacheService`): Mock runner configuration
- All cache operations use Zod schema validation

**Job Queue** (`src/queue/`): Three job types processed asynchronously:
- `GENERATE_PAYLOAD_JOB` — generates mock ONDC payloads via `@ondc/automation-mock-runner`
- `SEND_TO_API_SERVICE_JOB` — forwards requests to external API service
- `API_SERVICE_FORM_REQUEST_JOB` — handles form submissions
- Uses in-memory queue in development, RabbitMQ in production

**Flow State Machine** (`src/service/flows/`): ONDC flows (search→select→confirm→etc.) have discrete sequence steps with status tracking (`STARTED`, `WORKING`, `SUSPENDED`, `COMPLETED`). Each step is BAP/BPP-owned and can be stackable or require user input.

**Standardized Response Utilities** (`src/utils/res-utils.ts`): A custom ESLint rule (`no-direct-response`) enforces that controllers never call `res.json()`/`res.send()` directly. Always use:
- `sendSuccess(res, data, simpleBody?, message?, statusCode?)`
- `sendError(res, errorCode, message?, details?)`
- `sendAck(res, context)` / `sendNack(res, context, code, message)`

### API Surface

Business routes prefixed `/mock/playground` (mounted in `src/server.ts`, registered in `src/routes/index.ts`):
- `POST /flows/new` — start a new transaction flow
- `POST /flows/proceed` — advance an existing flow
- `GET /flows/current-status` — get flow status and sequence
- `POST /manual/:action` — trigger a specific ONDC action
- `POST /forms/submit` — submit form data
- `DELETE /backdoor/clear-flows` — clear cached flow configs (query: `domain` req, `version` opt, `flowId` opt)

Ops endpoints mounted at app root (not under `/mock/playground`):
- `GET /health`, `GET /metrics`, `GET /memory`, `GET /heapdump`

### Environment Variables

Required at runtime (validated in `src/env.ts`):
```
NODE_ENV, PORT, LOG_LEVEL, BASE_URL
API_SERVICE_URL, CONFIG_SERVICE_URL
REDIS_HOST, REDIS_PORT, REDIS_DB_0, REDIS_DB_1
REDIS_USERNAME, REDIS_PASSWORD (optional)
RABBITMQ_URL (optional, defaults to in-memory queue)
MEMORY_PROFILER_INTERVAL_MS
```

### Error Handling

Custom error classes live in `src/errors/`. Throw `OndcProtocolError` for ONDC protocol violations or `InternalServerError` for service failures — both are caught by the global error handler middleware (`src/middlewares/error-handler.ts`) which maps them to structured responses. Error codes are centralized in `src/errors/error-codes.ts`.

### Form Steps — HTML_FORM and DYNAMIC_FORM

Form steps are **not** regular ONDC API actions. They sit between two API steps in the flow sequence and use entirely separate code paths. Getting this wrong is a common source of bugs.

#### DYNAMIC_FORM

Used when **this mock service generates** a form for the user to fill in.

- Triggered by `actOnFlowService` (`src/service/flows/process-flow.ts`) when the next pending step is `DYNAMIC_FORM`
- Flow: caller hits `POST /flows/proceed` with `inputs.submission_id` → `actOnFlowService` calls `addFormSubmissionId()` then enqueues `API_SERVICE_FORM_REQUEST_JOB` with `formType: 'DYNAMIC_FORM'` and the submission ID
- Form rendering and submission are handled by `POST /forms/submit` (`src/service/forms/form-handlers.ts`)
- The submitted form data ends up in session under `sessionData[formActionId]` and surfaces in `reference_data` in the flow status response

#### HTML_FORM / HTML_FORM_MULTI

Used when an **external party's API response** embeds a link to a third-party HTML form that the user must complete. The mock service does not generate this form — it validates and prepares it.

**Data contract**: before the HTML_FORM step is reached, the upstream API call (e.g. `on_init`) must have caused the mock runner's `saveData` config to write the form URL into session data under the form's action ID key:
```
sessionData[nextStep.actionId] = "https://external-bank.com/kyc-form"
```

**Processing** (`processHtmlFormStep` in `src/controllers/incoming-request-controller.ts`):  
Triggered automatically after the preceding API step passes validation and its data is saved. Steps:
1. Read `sessionData[nextStep.actionId]` — this is the form URL
2. `axios.get(formLink)` — fetch the raw HTML
3. `validateFormHtml(html)` (`src/utils/form-utils.ts`) — security scan: rejects `<iframe>`/`<object>`/`<embed>`, inline event handlers (`onclick`, etc.), `javascript:` URLs, multiple `<form>` elements
4. **Fail** → enqueue `API_SERVICE_FORM_REQUEST_JOB` with `error` → ACK (`shouldRespond: true`)
5. **Pass** → `resolveFormActions(formLink, html)` (`src/utils/form-utils.ts`) — rewrites relative `<form action>` URLs to absolute using the form link as base → `overwriteMockSessionData` saves the resolved HTML back under the same key → continue (`shouldRespond: false`)

The resolved HTML stored in session is read back by `getReferenceData` (`src/utils/flow-utils.ts`) which collects all `HTML_FORM` and `DYNAMIC_FORM` step keys from the flow sequence and includes their session values in the `reference_data` field of the flow status response.

#### Cache operation distinction

- `saveMockSessionData(txId, url, payload, saveDataConfig, sessionId)` — **merges** extracted fields from an ONDC payload into session using JSONPath/EVAL expressions from the mock config. Use this for API step data.
- `overwriteMockSessionData(txId, url, data)` — **replaces** the entire session object. Use this when the whole session needs to be rewritten (e.g. after resolving form HTML).

### Testing

Jest with `ts-jest`. Tests live alongside source as `*.test.ts` files or in `src/test/`. There is a test setup file at `src/test/setup.ts`.
