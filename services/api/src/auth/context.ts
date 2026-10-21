import type { Request, Response } from 'express';
import type { components } from '@resolvehub/generated';
import { ApiFault } from '../application/fault.js';

export type Identity = components['schemas']['Identity'];
export interface ApiRequest extends Request {
  requestId: string;
  rawBody?: Buffer;
  identity?: Identity;
  authentication?: Promise<Identity>;
}
export interface GraphqlContext {
  req: ApiRequest;
  res: Response;
}

export function identityOf(request: Pick<ApiRequest, 'identity'>): Identity {
  if (!request.identity) throw new ApiFault(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.identity;
}
