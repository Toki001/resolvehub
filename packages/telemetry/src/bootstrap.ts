import { register } from 'node:module';
import { diag } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import {
  AggregationType,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  InstrumentType,
} from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { z } from 'zod';
import { labelKeys, count, safeAttributes } from './index.js';
import { RedactingMetricExporter, RedactingSpanProcessor, safeResource } from './privacy.js';

const schema = z.object({
  OTEL_ENABLED: z.enum(['true', 'false']).default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .refine(
      (value) => /^https?:/.test(value) && !new URL(value).username && !new URL(value).password,
    )
    .default('http://127.0.0.1:4318'),
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});
export function telemetryConfig(input: NodeJS.ProcessEnv) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid telemetry environment: ${[...new Set(result.error.issues.map((issue) => issue.path[0]))].join(', ')}`,
    );
  return result.data;
}
let active: NodeSDK | undefined;
export function initializeTelemetry(
  service: 'resolvehub-api' | 'resolvehub-worker' | 'resolvehub-web',
  instrumentDependencies = true,
) {
  const config = telemetryConfig(process.env);
  if (config.OTEL_ENABLED === 'false' || active) return;
  if (instrumentDependencies) register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const resource = safeResource(service, config.NODE_ENV);
  const exporter = new OTLPTraceExporter({
    url: new URL('/v1/traces', config.OTEL_EXPORTER_OTLP_ENDPOINT).href,
    timeoutMillis: 2000,
  });
  const batch = new BatchSpanProcessor({
    exporter: {
      export: (spans, callback) =>
        exporter.export(spans, (result) => {
          if (result.code !== 0) count('telemetry_export_failures');
          callback(result);
        }),
      shutdown: () => exporter.shutdown(),
    },
    maxQueueSize: 2048,
    maxExportBatchSize: 128,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 2500,
  });
  active = new NodeSDK({
    autoDetectResources: false,
    resource,
    textMapPropagator: new W3CTraceContextPropagator(),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.OTEL_TRACE_SAMPLE_RATIO),
    }),
    spanProcessors: [new RedactingSpanProcessor(batch, resource)],
    logRecordProcessors: [],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new RedactingMetricExporter(
          new OTLPMetricExporter({
            url: new URL('/v1/metrics', config.OTEL_EXPORTER_OTLP_ENDPOINT).href,
            timeoutMillis: 2000,
          }),
          resource,
        ),
        exportIntervalMillis: config.OTEL_METRIC_EXPORT_INTERVAL_MS,
        exportTimeoutMillis: Math.min(2500, config.OTEL_METRIC_EXPORT_INTERVAL_MS),
      }),
    ],
    views: [
      {
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [
              0, 0.001, 0.005, 0.01, 0.015, 0.02, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 6, 10, 30,
              60, 120,
            ],
          },
        },
        attributesProcessors: [createAllowListAttributesProcessor(labelKeys)],
        aggregationCardinalityLimit: 200,
      },
      {
        instrumentType: InstrumentType.COUNTER,
        attributesProcessors: [createAllowListAttributesProcessor(labelKeys)],
        aggregationCardinalityLimit: 200,
      },
      {
        instrumentType: InstrumentType.GAUGE,
        attributesProcessors: [createAllowListAttributesProcessor(labelKeys)],
        aggregationCardinalityLimit: 200,
      },
    ],
    instrumentations: instrumentDependencies
      ? [
          new PgInstrumentation({
            enhancedDatabaseReporting: false,
            requireParentSpan: true,
            ignoreConnectSpans: true,
            addSqlCommenterCommentToQueries: false,
            requestHook: (span, info) => {
              const command = info.query.text.trim().split(/\s/)[0]?.toUpperCase() ?? 'OTHER';
              span.setAttributes(
                safeAttributes({ 'db.system': 'postgresql', 'db.operation': command }),
              );
            },
          }),
          new IORedisInstrumentation({
            requireParentSpan: true,
            dbStatementSerializer: (command) => command,
            requestHook: (span, info) =>
              span.setAttributes(
                safeAttributes({
                  'db.system': 'redis',
                  'db.operation': info.cmdName.toUpperCase(),
                }),
              ),
          }),
        ]
      : [],
  });
  active.start();
  // SDK diagnostic payload logging is disabled; bounded failure counters remain.
  diag.disable();
}
export async function shutdownTelemetry() {
  const sdk = active;
  active = undefined;
  await sdk?.shutdown().catch(() => {
    /* Telemetry cannot change the application outcome. */
  });
}
