import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { print } from 'graphql';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { createApiClient } from '@resolvehub/generated';
import { traceHeaders } from '@resolvehub/telemetry';
import { errorSchema } from '@resolvehub/contracts';
import { z } from 'zod';
import { parseWebEnv } from './env';
import { identitySchema } from './workspace-schemas';
import { sameOrigin } from './action-policy';

export const SESSION_COOKIE = 'rh_session';
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
export function apiError(error: unknown): WorkspaceError {
  const parsed = errorSchema.safeParse(error);
  return parsed.success
    ? new WorkspaceError(parsed.data.code, parsed.data.message, parsed.data.requestId)
    : new WorkspaceError(
        'DEPENDENCY_UNAVAILABLE',
        'The support service is unavailable. Please try again.',
      );
}
export async function assertActionOrigin() {
  const h = await headers();
  if (!sameOrigin(h.get('origin'), h.get('host')))
    throw new WorkspaceError('FORBIDDEN', 'This action requires a request from this workspace.');
}
export async function workspaceClient(token?: string) {
  const credential = token ?? (await cookies()).get(SESSION_COOKIE)?.value;
  if (!credential) throw new WorkspaceError('UNAUTHENTICATED', 'Sign in to your workspace first.');
  const client = createApiClient(parseWebEnv(process.env).API_URL, credential);
  client.use({
    onRequest({ request }) {
      for (const [key, value] of Object.entries(traceHeaders())) request.headers.set(key, value);
      return new Request(request, { cache: 'no-store' });
    },
  });
  return client;
}
export const sessionIdentity = cache(async () => {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) return null;
  try {
    const client = await workspaceClient();
    const result = await client.GET('/v1/me', { signal: AbortSignal.timeout(5000) });
    if (result.response.status === 401) return null;
    if (result.error) throw apiError(result.error);
    return identitySchema.parse(result.data);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw apiError(error);
  }
});
export async function graph<T, V>(
  document: TypedDocumentNode<T, V>,
  variables: V,
  validator: z.ZodType<T>,
): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new WorkspaceError('UNAUTHENTICATED', 'Sign in to your workspace first.');
  const response = await fetch(new URL('/graphql', parseWebEnv(process.env).API_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...traceHeaders(),
    },
    body: JSON.stringify({ query: print(document), variables }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw apiError(undefined);
  });
  const result = z
    .object({
      data: z.unknown().optional(),
      errors: z
        .array(
          z.object({
            message: z.string(),
            extensions: z
              .object({ code: z.string().optional(), requestId: z.string().optional() })
              .optional(),
          }),
        )
        .optional(),
    })
    .parse(await response.json());
  const error = result.errors?.[0];
  if (error)
    throw new WorkspaceError(
      error.extensions?.code ?? 'INTERNAL_ERROR',
      error.message,
      error.extensions?.requestId,
    );
  if (!response.ok) throw apiError(undefined);
  return validator.parse(result.data);
}
