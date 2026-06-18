import client from 'prom-client';

/**
 * Central metrics registry for the service.
 *
 * CARDINALITY RULE (hard): Prometheus labels MUST be low-cardinality. Allowed:
 *   domain, version, action, job_name, code, status, route(template), cache_op,
 *   result, target, kind, queue, db, from, to.
 * NEVER use transaction_id / session_id / message_id / flow_id / subscriber_url
 * as labels — they are unbounded and would explode the TSDB. Those live in the
 * LOG BODY (Loki) instead. Keep `route` an express route TEMPLATE, never a raw
 * URL containing ids.
 */

export const register = client.register;
export const metricsContentType = register.contentType;

// Node.js process/runtime metrics (event-loop lag, GC, heap, handles, …).
client.collectDefaultMetrics({ register });

/** Replace empty/undefined label values with a stable placeholder. */
export const lbl = (v: unknown): string =>
    v === undefined || v === null || v === '' ? 'unknown' : String(v);

// ── HTTP RED ────────────────────────────────────────────────────────────────
export const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
});

export const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsInFlight = new client.Gauge({
    name: 'http_requests_in_flight',
    help: 'In-flight HTTP requests',
});

// ── ONDC ACK / NACK / errors ─────────────────────────────────────────────────
export const mockAckTotal = new client.Counter({
    name: 'mock_ack_total',
    help: 'ONDC ACK responses sent',
    labelNames: ['action', 'domain', 'version'] as const,
});

export const mockNackTotal = new client.Counter({
    name: 'mock_nack_total',
    help: 'ONDC NACK responses sent',
    labelNames: ['code', 'action', 'domain', 'version'] as const,
});

export const mockErrorsTotal = new client.Counter({
    name: 'mock_errors_total',
    help: 'Errors surfaced by the service',
    labelNames: ['error_type', 'component'] as const,
});

// ── Jobs / queue ─────────────────────────────────────────────────────────────
export const mockJobsEnqueuedTotal = new client.Counter({
    name: 'mock_jobs_enqueued_total',
    help: 'Jobs enqueued',
    labelNames: ['job_name'] as const,
});

export const mockJobsCompletedTotal = new client.Counter({
    name: 'mock_jobs_completed_total',
    help: 'Jobs completed successfully',
    labelNames: ['job_name'] as const,
});

export const mockJobsFailedTotal = new client.Counter({
    name: 'mock_jobs_failed_total',
    help: 'Jobs that terminally failed',
    labelNames: ['job_name'] as const,
});

export const mockJobDuration = new client.Histogram({
    name: 'mock_job_duration_seconds',
    help: 'Job handler duration in seconds',
    labelNames: ['job_name', 'result'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

export const mockQueueDepth = new client.Gauge({
    name: 'mock_queue_depth',
    help: 'Approximate number of jobs waiting in the queue',
    labelNames: ['queue'] as const,
});

// ── Flow state machine ───────────────────────────────────────────────────────
// Recorded per setFlowStatus/setExtraFlowStatus call by target status. A rising
// rate of `to="WORKING"` without matching `to="AVAILABLE"` surfaces stuck flows
// (avoids a drift-prone inc/dec gauge that would need a read-before-write).
export const mockFlowStateTransitionsTotal = new client.Counter({
    name: 'mock_flow_state_transitions_total',
    help: 'Flow status transitions, by target status',
    labelNames: ['to', 'extra', 'domain', 'version'] as const,
});

// ── Cache ────────────────────────────────────────────────────────────────────
export const cacheOperationsTotal = new client.Counter({
    name: 'cache_operations_total',
    help: 'Redis cache operations',
    labelNames: ['cache_op', 'result', 'db'] as const,
});

export const cacheOperationDuration = new client.Histogram({
    name: 'cache_operation_duration_seconds',
    help: 'Redis cache operation duration in seconds',
    labelNames: ['cache_op', 'db'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// ── External dependencies ────────────────────────────────────────────────────
export const externalRequestsTotal = new client.Counter({
    name: 'external_requests_total',
    help: 'Outbound requests to external services',
    labelNames: ['target', 'status'] as const,
});

export const externalRequestDuration = new client.Histogram({
    name: 'external_request_duration_seconds',
    help: 'Outbound external request duration in seconds',
    labelNames: ['target', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// ── Process ──────────────────────────────────────────────────────────────────
export const processUnhandledTotal = new client.Counter({
    name: 'process_unhandled_total',
    help: 'Unhandled rejections / uncaught exceptions observed',
    labelNames: ['kind'] as const,
});

export async function metricsText(): Promise<string> {
    return register.metrics();
}
