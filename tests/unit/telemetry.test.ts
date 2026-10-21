import {
  context,
  metrics,
  propagation,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  observed,
  captureTraceContext,
  queueTraceMetadata,
  traceContext,
  safeAttributes,
  validTraceparent,
  routeTemplate,
  modelLabel,
  count,
  observe,
  gauge,
  beginHttp,
} from '@resolvehub/telemetry';
import {
  RedactingMetricExporter,
  RedactingSpanProcessor,
  safeResource,
} from '../../packages/telemetry/src/privacy.js';
import { telemetryConfig } from '@resolvehub/telemetry/bootstrap';

const secret = 'CUSTOMER_CANARY_person@example.test_private_token';
const resource = safeResource('resolvehub-api', 'test');
const spans = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [
    new RedactingSpanProcessor(new SimpleSpanProcessor({ exporter: spans }), resource),
  ],
});
const metricExport = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricProvider = new MeterProvider({
  resource: resourceFromAttributes({ 'service.name': secret, 'process.command_args': [secret] }),
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new RedactingMetricExporter(metricExport, resource),
      exportIntervalMillis: 60000,
    }),
  ],
});
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  metrics.setGlobalMeterProvider(metricProvider);
});
afterAll(async () => {
  await provider.shutdown();
  await metricProvider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});
test('PII is removed from span names, attributes, exceptions, status, events, links, resources and metrics', async () => {
  await observed(
    'rag.generation',
    { model: secret, provider: 'mock', organization_id: secret, prompt: secret },
    async () => {
      const span = trace.getSpan(context.active());
      span?.setAttribute('db.statement', `SELECT '${secret}'`);
      span?.recordException(new Error(secret));
      span?.addEvent(secret, { body: secret });
      span?.setStatus({ code: SpanStatusCode.ERROR, message: secret });
      trace
        .getTracer(secret)
        .startSpan(secret, {
          links: [
            {
              context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 },
              attributes: { email: secret },
            },
          ],
          attributes: { customer_text: secret },
        })
        .end();
      count('model_tokens', 14, { token_type: 'input', provider: 'mock', tenant_id: secret });
      observe('draft_cost_usd', 0.01, { model: secret });
      gauge('queue_pending', 1000, { job_kind: 'document_ingestion', customer: secret });
      metrics.getMeter('rogue').createCounter('rogue_secret_metric').add(1, { body: secret });
    },
  );
  await provider.forceFlush();
  await metricProvider.forceFlush();
  const exportedSpans = spans.getFinishedSpans();
  expect(exportedSpans.some((span) => span.name === 'rag.generation')).toBe(true);
  expect(exportedSpans.some((span) => span.name === 'framework.request')).toBe(true);
  expect(JSON.stringify(exportedSpans)).not.toContain(secret);
  expect(exportedSpans.every((span) => span.events.length === 0 && span.links.length === 0)).toBe(
    true,
  );
  const exportedMetrics = metricExport.getMetrics();
  expect(exportedMetrics.length).toBeGreaterThan(0);
  expect(JSON.stringify(exportedMetrics)).not.toContain(secret);
  expect(JSON.stringify(exportedMetrics)).not.toContain('rogue_secret_metric');
  expect(JSON.stringify(exportedMetrics)).toContain('resolvehub_model_tokens');
});
test('async job metadata carries the same trace with a distinct child span and never baggage or tracestate', async () => {
  const parent = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`;
  let metadata = '';
  await observed(
    'queue.publish',
    { job_kind: 'draft_response' },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      metadata = queueTraceMetadata();
      expect(captureTraceContext()).toEqual({ traceparent: metadata });
    },
    traceContext(parent),
  );
  await observed(
    'queue.consume',
    { job_kind: 'draft_response' },
    async () => {
      expect(trace.getSpan(context.active())?.spanContext().traceId).toBe('c'.repeat(32));
      expect(queueTraceMetadata()).not.toBe(metadata);
    },
    traceContext(metadata),
  );
  await provider.forceFlush();
  const consume = spans.getFinishedSpans().find((span) => span.name === 'queue.consume');
  expect(consume?.parentSpanContext?.spanId).toBe(metadata.split('-')[2]);
  expect(Object.keys(captureTraceContext())).toHaveLength(0);
});
test.each([
  undefined,
  [],
  '0'.repeat(55),
  `00-${'0'.repeat(32)}-${'d'.repeat(16)}-01`,
  `00-${'c'.repeat(32)}-${'0'.repeat(16)}-01`,
  secret,
  `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01\n`,
  `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01\n${secret}`,
])('invalid trace context is rejected: %j', (value) => {
  expect(validTraceparent(value)).toBe(false);
  expect(traceContext(value)).toBe(ROOT_CONTEXT);
});
test('paths, model names and label values stay bounded even for valid IDs and adversarial input', () => {
  expect(
    routeTemplate('/v1/tickets/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/drafts?email=' + secret),
  ).toBe('/v1/tickets/:id/drafts');
  expect(routeTemplate('/' + secret)).toBe('other');
  expect(modelLabel(secret)).toBe('operator-configured');
  expect(
    safeAttributes({
      route: '/v1/tickets',
      method: secret,
      tenant: secret,
      model: secret,
      token_type: 'input',
    }),
  ).toEqual({ route: '/v1/tickets', token_type: 'input' });
});
test('HTTP request duration/count and failed operation traces are recorded without raw errors', async () => {
  beginHttp('/v1/tickets', 'POST', undefined, (_span, done) => {
    done(503);
    done(200);
  });
  beginHttp('/unknown/' + secret, 'CUSTOM_METHOD', undefined, (_span, done) => done(499));
  await expect(
    observed('rag.retrieval', {}, () => Promise.reject(new Error(secret))),
  ).rejects.toThrow(secret);
  count('model_tokens', -1);
  observe('draft_cost_usd', Number.NaN);
  gauge('queue_pending', Infinity);
  await provider.forceFlush();
  await metricProvider.forceFlush();
  expect(JSON.stringify(spans.getFinishedSpans())).not.toContain(secret);
  expect(JSON.stringify(metricExport.getMetrics())).toContain('5xx');
});
test('invalid telemetry configuration reports field names without values', () => {
  expect(() =>
    telemetryConfig({
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://${secret}@host`,
    }),
  ).toThrow('OTEL_EXPORTER_OTLP_ENDPOINT');
  try {
    telemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: secret });
  } catch (error) {
    expect(String(error)).not.toContain(secret);
  }
});
