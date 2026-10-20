import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import { parse } from 'yaml';
import { z } from 'zod';
import type { components } from '@resolvehub/generated';

const source = z
  .object({
    paths: z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({ responses: z.record(z.string(), z.unknown()) }).passthrough(),
      ),
    ),
    components: z.object({
      schemas: z.record(z.string(), z.record(z.string(), z.json())),
      responses: z.record(z.string(), z.json()),
    }),
  })
  .passthrough()
  .parse(parse(readFileSync('packages/contracts/openapi.yaml', 'utf8')));
const ajv = new Ajv2020({ strict: false, allErrors: true });
formatsPlugin.default(ajv);
ajv.addSchema({ $id: 'urn:resolvehub:test', components: source.components, paths: source.paths });
const pointer = (part: string) => part.replace(/~/g, '~0').replace(/\//g, '~1');

export function schema<K extends keyof components['schemas']>(
  name: K,
  input: unknown,
): components['schemas'][K] {
  const validate = ajv.compile<components['schemas'][K]>({
    $ref: `urn:resolvehub:test#/components/schemas/${name}`,
  });
  if (!validate(input)) throw new Error(`Invalid ${name}: ${JSON.stringify(validate.errors)}`);
  return input;
}

export function assertRest(template: string, method: string, response: Response, body: unknown) {
  const operation = source.paths[template]?.[method.toLowerCase()];
  if (!operation || !operation.responses[String(response.status)])
    throw new Error(`Undeclared response: ${method} ${template} ${response.status}`);
  const error = response.status >= 400 && !template.startsWith('/health/');
  const reference = error
    ? 'urn:resolvehub:test#/components/schemas/Error'
    : `urn:resolvehub:test#/paths/${pointer(template)}/${method.toLowerCase()}/responses/${response.status}/content/application~1json/schema`;
  const validate = ajv.compile({ $ref: reference });
  if (!validate(body))
    throw new Error(`Response contract drift: ${JSON.stringify(validate.errors)}`);
  expect(z.uuid().safeParse(response.headers.get('x-request-id')).success).toBe(true);
  if (error) expect(schema('Error', body).requestId).toBe(response.headers.get('x-request-id'));
}

export const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3001';
export async function rest(
  method: 'GET' | 'POST',
  template: string,
  url: string,
  options: {
    token?: string;
    key?: string;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(`${apiUrl}${url}`, {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      ...options.headers,
    },
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
  const body: unknown = await response.json();
  assertRest(template, method, response, body);
  return { response, body };
}

const graphSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z
          .object({
            code: z.string(),
            message: z.string(),
            requestId: z.uuid(),
            httpStatus: z.number(),
          })
          .passthrough(),
      }),
    )
    .optional(),
  extensions: z.object({ requestId: z.uuid() }),
});
export async function graph(
  token: string | undefined,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const response = await fetch(`${apiUrl}/graphql`, {
    method: 'POST',
    signal: AbortSignal.timeout(8_000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = graphSchema.parse(await response.json());
  expect(body.extensions.requestId).toBe(response.headers.get('x-request-id'));
  for (const error of body.errors ?? [])
    expect(error.extensions.requestId).toBe(body.extensions.requestId);
  return { response, body };
}
