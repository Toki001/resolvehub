import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Attributes, Context, Span, Counter, Histogram, Gauge } from '@opentelemetry/api';

export { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace };
export type { Attributes, Context, Span };
export type JobKind = 'document_ingestion' | 'draft_response';
export const operations = [
  'http.request',
  'web.status',
  'graphql.request',
  'graphql.resolve',
  'queue.publish',
  'queue.consume',
  'ingestion.download',
  'ingestion.extract',
  'ingestion.chunk',
  'ingestion.embed',
  'ingestion.publish',
  'rag.draft',
  'rag.embedding',
  'rag.retrieval',
  'rag.rerank',
  'rag.context',
  'rag.generation',
  'rag.validation',
] as const;
export type Operation = (typeof operations)[number];
const allowedValues: Record<string, readonly string[]> = {
  operation: operations,
  job_kind: ['document_ingestion', 'draft_response'],
  outcome: ['success', 'error', 'answer', 'insufficient_evidence'],
  stage: ['download', 'extract', 'chunk', 'embed', 'publish'],
  provider: ['mock', 'ollama'],
  model: ['resolvehub-extractive-mock-v1', 'resolvehub-synthetic-sha256-v1', 'operator-configured'],
  token_type: ['input', 'output', 'embedding'],
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'],
  status_class: ['1xx', '2xx', '3xx', '4xx', '5xx'],
  field: [
    'reviewQueue',
    'backgroundJobs',
    'messageHistory',
    'tickets',
    'ticket',
    'knowledgeDocuments',
    'knowledgeSearch',
    'draft',
    'dashboardSummary',
    'messages',
    'drafts',
    'other',
  ],
  'db.system': ['postgresql', 'redis'],
  'db.operation': [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SET',
    'RESET',
    'GET',
    'SETEX',
    'EVAL',
    'EVALSHA',
    'PING',
    'HGET',
    'HGETALL',
    'HSET',
    'DEL',
    'ZADD',
    'ZREM',
    'XADD',
    'XREAD',
    'XREADGROUP',
    'OTHER',
  ],
};
const routes = [
  '/',
  '/tickets',
  '/knowledge',
  '/review',
  '/settings',
  '/api/health',
  '/api/status',
  '/health/live',
  '/health/ready',
  '/graphql',
  '/v1/me',
  '/v1/documents/uploads',
  '/v1/drafts/:id/edits',
  '/v1/tickets/:id/status',
  '/v1/tickets/:id/messages',
  '/v1/tickets',
  '/v1/documents/ingestions',
  '/v1/documents/:id/versions',
  '/v1/tickets/:id/drafts',
  '/v1/jobs/:id',
  '/v1/jobs/:id/failure',
  '/v1/jobs/:id/replay',
  '/v1/drafts/:id/approve',
  '/v1/drafts/:id/reject',
  '/v1/webhooks/:id',
  'other',
];
allowedValues.route = routes;
export const labelKeys = Object.keys(allowedValues);
export function safeAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) => typeof value === 'string' && allowedValues[key]?.includes(value),
    ),
  );
}
export function routeTemplate(path: string): string {
  const clean = path.split('?')[0] ?? '';
  if (routes.includes(clean)) return clean;
  const match = routes.find(
    (route) =>
      route.includes(':id') &&
      new RegExp(`^${route.replace(':id', '[a-fA-F0-9-]{36}')}$`).test(clean),
  );
  return match ?? 'other';
}
export function modelLabel(model: string) {
  return allowedValues.model?.includes(model) ? model : 'operator-configured';
}
export function validTraceparent(input: unknown): input is string {
  return (
    typeof input === 'string' &&
    input.length === 55 &&
    /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(input) &&
    input.slice(3, 35) !== '0'.repeat(32) &&
    input.slice(36, 52) !== '0'.repeat(16)
  );
}
export function captureTraceContext(): { traceparent?: string } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return validTraceparent(carrier.traceparent) ? { traceparent: carrier.traceparent } : {};
}
export function traceContext(parent: unknown): Context {
  return validTraceparent(parent)
    ? propagation.extract(ROOT_CONTEXT, { traceparent: parent })
    : ROOT_CONTEXT;
}
export function queueTraceMetadata(): string {
  return captureTraceContext().traceparent ?? '';
}
export function traceHeaders(): Record<string, string> {
  return { ...captureTraceContext() };
}
export const tracer = trace.getTracer('resolvehub', '0.1.0');
const meter = () => metrics.getMeter('resolvehub', '0.1.0');
const counterNames = [
  'http_requests',
  'graphql_requests',
  'operation_failures',
  'queue_retries',
  'queue_dead_letter_events',
  'ingestion_completed',
  'drafts_completed',
  'model_tokens',
  'model_cost_usd',
  'model_usage_incomplete',
  'telemetry_export_failures',
] as const;
const histogramNames = [
  'http_request_duration_seconds',
  'graphql_request_duration_seconds',
  'operation_duration_seconds',
  'queue_wait_duration_seconds',
  'ingestion_duration_seconds',
  'rag_retrieval_duration_seconds',
  'generation_duration_seconds',
  'draft_cost_usd',
  'draft_duration_seconds',
] as const;
const gaugeNames = [
  'queue_pending',
  'queue_active',
  'queue_oldest_age_seconds',
  'queue_dead_letters',
  'queue_retries_durable',
  'queue_observation_age_seconds',
] as const;
export const metricNames = [...counterNames, ...histogramNames, ...gaugeNames].map(
  (name) => `resolvehub_${name}`,
);
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();
function counter(name: string) {
  let instrument = counters.get(name);
  if (!instrument) {
    instrument = meter().createCounter(`resolvehub_${name}`);
    counters.set(name, instrument);
  }
  return instrument;
}
function histogram(name: string) {
  let instrument = histograms.get(name);
  if (!instrument) {
    instrument = meter().createHistogram(`resolvehub_${name}`);
    histograms.set(name, instrument);
  }
  return instrument;
}
export function count(name: (typeof counterNames)[number], value = 1, attributes: Attributes = {}) {
  if (Number.isFinite(value) && value >= 0) counter(name).add(value, safeAttributes(attributes));
}
export function observe(
  name: (typeof histogramNames)[number],
  value: number,
  attributes: Attributes = {},
) {
  if (Number.isFinite(value) && value >= 0)
    histogram(name).record(value, safeAttributes(attributes));
}
export function gauge(
  name: (typeof gaugeNames)[number],
  value: number,
  attributes: Attributes = {},
) {
  if (!Number.isFinite(value) || value < 0) return;
  let instrument = gauges.get(name);
  if (!instrument) {
    instrument = meter().createGauge(`resolvehub_${name}`);
    gauges.set(name, instrument);
  }
  instrument.record(value, safeAttributes(attributes));
}
export async function observed<T>(
  operation: Operation,
  attributes: Attributes,
  action: () => Promise<T>,
  parent = context.active(),
  kind = SpanKind.INTERNAL,
): Promise<T> {
  const labels = safeAttributes({ ...attributes, operation });
  return tracer.startActiveSpan(operation, { kind, attributes: labels }, parent, async (span) => {
    const start = performance.now();
    try {
      const result = await action();
      span.setAttribute('outcome', 'success');
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('outcome', 'error');
      count('operation_failures', 1, labels);
      throw error;
    } finally {
      observe('operation_duration_seconds', (performance.now() - start) / 1000, labels);
      span.end();
    }
  });
}
export function beginHttp(
  path: string,
  method: string,
  parent: unknown,
  action: (span: Span, done: (status: number) => void) => void,
) {
  const labels = safeAttributes({
    route: routeTemplate(path),
    method: allowedValues.method?.includes(method) ? method : 'OTHER',
  });
  tracer.startActiveSpan(
    'http.request',
    { kind: SpanKind.SERVER, attributes: { ...labels, operation: 'http.request' } },
    traceContext(parent),
    (span) => {
      const start = performance.now();
      let ended = false;
      action(span, (status) => {
        if (ended) return;
        ended = true;
        const statusClass = `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`;
        count('http_requests', 1, { ...labels, status_class: statusClass });
        observe('http_request_duration_seconds', (performance.now() - start) / 1000, labels);
        span.setAttribute('status_class', statusClass);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      });
    },
  );
}
