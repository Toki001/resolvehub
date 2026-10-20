import createClient from 'openapi-fetch';
import type { paths } from './rest.js';

export type { paths, components } from './rest.js';
export * from './graphql/graphql.js';
export const createApiClient = (baseUrl: string, bearerToken?: string) =>
  createClient<paths>({
    baseUrl,
    ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {}),
  });
