import { z } from 'zod';
import { ApiFault } from './fault.js';
import type { Identity } from '../auth/context.js';

export const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .refine((key) => !/[^A-Za-z0-9_-]/.test(key));

export function requireWriteAccess(identity: Identity, admin = false): void {
  if (identity.role === 'analyst' || (admin && identity.role !== 'admin'))
    throw new ApiFault(403, 'FORBIDDEN', 'Access is denied.');
}
