import { randomUUID } from 'node:crypto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor, Span } from '@opentelemetry/sdk-trace';
import type { Context, SpanContext } from '@opentelemetry/api';
import type {
  PushMetricExporter,
  ResourceMetrics,
  MetricData,
  DataPoint,
} from '@opentelemetry/sdk-metrics';
import { DataPointType } from '@opentelemetry/sdk-metrics';
import type { ExportResult } from '@opentelemetry/core';
import { safeAttributes, operations, count, metricNames } from './index.js';

export function safeResource(
  service: 'resolvehub-api' | 'resolvehub-worker' | 'resolvehub-web',
  environment: 'development' | 'test' | 'production',
): Resource {
  return resourceFromAttributes({
    'service.name': service,
    'service.instance.id': randomUUID(),
    'service.version': '0.1.0',
    'deployment.environment.name': environment,
  });
}
function spanContext(value: SpanContext): SpanContext {
  return { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags };
}
export function redactSpan(span: ReadableSpan, resource: Resource): ReadableSpan {
  const attributes = safeAttributes(span.attributes);
  const operation = operations.find((name) => name === span.name);
  const name =
    operation ??
    (span.instrumentationScope.name.includes('ioredis')
      ? 'redis.command'
      : span.instrumentationScope.name.includes('pg')
        ? 'postgresql.query'
        : 'framework.request');
  return {
    name,
    attributes,
    resource,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    spanContext: () => spanContext(span.spanContext()),
    ...(span.parentSpanContext ? { parentSpanContext: spanContext(span.parentSpanContext) } : {}),
    status: { code: span.status.code },
    events: [],
    links: [],
    instrumentationScope: { name: 'resolvehub', version: '0.1.0' },
  };
}
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly delegate: SpanProcessor,
    private readonly resource: Resource,
  ) {}
  onStart(_span: Span, _parent: Context) {
    /* Redaction occurs before buffering/export. */
  }
  onEnd(span: ReadableSpan) {
    this.delegate.onEnd(redactSpan(span, this.resource));
  }
  forceFlush() {
    return this.delegate.forceFlush();
  }
  shutdown() {
    return this.delegate.shutdown();
  }
}
function points<T>(data: DataPoint<T>[]): DataPoint<T>[] {
  return data.map((point) => ({
    startTime: point.startTime,
    endTime: point.endTime,
    value: point.value,
    attributes: safeAttributes(point.attributes),
  }));
}
function redactMetric(metric: MetricData): MetricData {
  switch (metric.dataPointType) {
    case DataPointType.HISTOGRAM:
      return {
        ...metric,
        descriptor: { ...metric.descriptor, description: '', unit: '' },
        dataPoints: points(metric.dataPoints),
      };
    case DataPointType.EXPONENTIAL_HISTOGRAM:
      return {
        ...metric,
        descriptor: { ...metric.descriptor, description: '', unit: '' },
        dataPoints: points(metric.dataPoints),
      };
    case DataPointType.SUM:
      return {
        ...metric,
        descriptor: { ...metric.descriptor, description: '', unit: '' },
        dataPoints: points(metric.dataPoints),
      };
    case DataPointType.GAUGE:
      return {
        ...metric,
        descriptor: { ...metric.descriptor, description: '', unit: '' },
        dataPoints: points(metric.dataPoints),
      };
  }
}
export class RedactingMetricExporter implements PushMetricExporter {
  constructor(
    private readonly delegate: PushMetricExporter,
    private readonly resource: Resource,
  ) {}
  export(input: ResourceMetrics, callback: (result: ExportResult) => void) {
    this.delegate.export(
      {
        resource: this.resource,
        scopeMetrics: input.scopeMetrics.map((scope) => ({
          scope: { name: 'resolvehub', version: '0.1.0' },
          metrics: scope.metrics
            .filter((metric) => metricNames.includes(metric.descriptor.name))
            .map(redactMetric),
        })),
      },
      (result) => {
        if (result.code !== 0) count('telemetry_export_failures');
        callback(result);
      },
    );
  }
  forceFlush() {
    return this.delegate.forceFlush();
  }
  shutdown() {
    return this.delegate.shutdown();
  }
}
