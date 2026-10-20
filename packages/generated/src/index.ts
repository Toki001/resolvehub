import createClient from 'openapi-fetch';
import type { paths } from './rest.js';

export type { paths, components } from './rest.js';
export const createApiClient = (baseUrl: string) => createClient<paths>({ baseUrl });
