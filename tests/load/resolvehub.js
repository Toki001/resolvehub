import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import execution from 'k6/execution';

// The runner owns this mode-0600 file. Credentials never appear in CLI arguments.
const input = JSON.parse(open(__ENV.RESOLVEHUB_LOAD_CONFIG));
const saturation = __ENV.RESOLVEHUB_SCENARIO === 'saturation';
const draftLatency = new Trend('draft_end_to_end_ms', true);
const draftCost = new Trend('draft_cost_usd');
const successes = new Counter('drafts_completed');
const failures = new Rate('draft_failures');
const accepted = new Counter('ingestions_accepted');
const rejected = new Counter('ingestions_rejected');
export const options = {
  scenarios: saturation
    ? {
        saturation: {
          executor: 'shared-iterations',
          vus: 10,
          iterations: 1005,
          maxDuration: '120s',
          exec: 'saturate',
        },
      }
    : {
        drafts: {
          executor: 'per-vu-iterations',
          vus: 10,
          iterations: 3,
          maxDuration: '120s',
          exec: 'draft',
        },
      },
  thresholds: saturation
    ? {
        ingestions_accepted: ['count==1000'],
        ingestions_rejected: ['count==5'],
        checks: ['rate==1'],
      }
    : {
        draft_end_to_end_ms: ['p(95)<=6000'],
        draft_cost_usd: ['max<=0.02'],
        draft_failures: ['rate==0'],
        drafts_completed: ['count==30'],
        checks: ['rate==1'],
      },
  summaryTrendStats: ['min', 'avg', 'med', 'p(50)', 'p(95)', 'p(99)', 'max'],
  systemTags: ['method', 'status', 'name', 'scenario', 'expected_response'],
  discardResponseBodies: false,
};
function headers(token, mutation = false) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(!saturation && __VU === 1 && __ITER === 0 ? { traceparent: input.draftTraceparent } : {}),
    ...(mutation
      ? { 'Idempotency-Key': `resolvehub_k6_${__ENV.RESOLVEHUB_SCENARIO}_${__VU}_${__ITER}` }
      : {}),
  };
}
function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}
function graph(token, query, variables) {
  return http.post(`${input.apiUrl}/graphql`, JSON.stringify({ query, variables }), {
    headers: headers(token),
    tags: { name: 'POST /graphql' },
    timeout: '5s',
  });
}
export function draft() {
  const item = input.cases[(__VU - 1 + __ITER * 10) % input.cases.length];
  const token = input.tokens[item.organizationId];
  const ticket = http.post(
    `${input.apiUrl}/v1/tickets`,
    JSON.stringify({
      subject: item.question,
      customerEmail: 'load@example.test',
      message: item.question,
    }),
    {
      headers: { ...headers(token), 'Idempotency-Key': `resolvehub_k6_ticket_${__VU}_${__ITER}` },
      tags: { name: 'POST /v1/tickets' },
      timeout: '5s',
    },
  );
  if (!check(ticket, { 'ticket created': (response) => response.status === 201 })) {
    failures.add(true);
    return;
  }
  const ticketId = json(ticket)?.id;
  const started = Date.now();
  const response = http.post(`${input.apiUrl}/v1/tickets/${ticketId}/drafts`, '{}', {
    headers: headers(token, true),
    tags: { name: 'POST /v1/tickets/:id/drafts' },
    timeout: '5s',
  });
  if (!check(response, { 'draft accepted asynchronously': (result) => result.status === 202 })) {
    failures.add(true);
    return;
  }
  const jobId = json(response)?.jobId;
  for (let attempts = 0; attempts < 200; attempts++) {
    const polled = http.get(`${input.apiUrl}/v1/jobs/${jobId}`, {
      headers: headers(token),
      tags: { name: 'GET /v1/jobs/:id' },
      timeout: '5s',
    });
    const job = json(polled);
    if (job?.status === 'failed') break;
    if (job?.status === 'succeeded') {
      const read = graph(
        token,
        'query Draft($id: ID!) { draft(id: $id) { status citations { chunkId } generation { estimatedCostUsd outcome } } }',
        { id: job.resourceId },
      );
      const body = json(read),
        result = body?.data?.draft;
      const valid = check(read, {
        'human approval still required': () => result?.status === 'pending',
        'answer has expected tenant evidence': () =>
          result?.generation?.outcome === 'answer' &&
          result?.citations?.some(
            (citation) => citation.chunkId === item.expectedEvidence[0].chunkId,
          ),
        'no GraphQL errors': () => !body?.errors,
      });
      draftLatency.add(Date.now() - started);
      draftCost.add(result?.generation?.estimatedCostUsd ?? 1);
      failures.add(!valid);
      if (valid) successes.add(1);
      return;
    }
    sleep(0.025);
  }
  failures.add(true);
}
export function saturate() {
  const identity = input.saturation;
  const response = http.post(
    `${input.apiUrl}/v1/documents/ingestions`,
    JSON.stringify(identity.input),
    {
      headers: {
        ...headers(identity.token),
        'Idempotency-Key': `resolvehub_k6_saturate_${execution.scenario.iterationInTest}`,
      },
      tags: { name: 'POST /v1/documents/ingestions' },
      timeout: '10s',
      responseCallback: http.expectedStatuses(202, 429),
    },
  );
  if (response.status === 202) accepted.add(1);
  if (response.status === 429) rejected.add(1);
  check(response, {
    'ingestion admitted or capacity rejected': (result) => [202, 429].includes(result.status),
    'capacity responses provide Retry-After': (result) =>
      result.status !== 429 || Number(result.headers['Retry-After']) > 0,
  });
}
export function handleSummary(data) {
  return {
    [__ENV.RESOLVEHUB_SUMMARY_PATH]: JSON.stringify(data, null, 2),
    stdout:
      JSON.stringify({ scenario: __ENV.RESOLVEHUB_SCENARIO, metrics: data.metrics }, null, 2) +
      '\n',
  };
}
