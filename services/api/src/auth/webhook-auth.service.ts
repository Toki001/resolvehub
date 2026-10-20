import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { API_ENV } from '../env.js';
import type { ApiEnv } from '../env.js';
import { unseal } from './crypto.js';
import { DatabaseService } from '../application/database.service.js';
import { ApiFault, unavailable } from '../application/fault.js';

const integrationSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  encryptedSecret: z.string(),
});
const headersSchema = z.object({
  id: z.uuid(),
  timestamp: z.string().regex(/^\d{10}$/),
  signature: z.string().regex(/^v1=[a-f0-9]{64}$/),
});

@Injectable()
export class WebhookAuthService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  async authenticate(inputHeaders: IncomingHttpHeaders, rawBody: Buffer | undefined) {
    const denied = () => new ApiFault(401, 'UNAUTHENTICATED', 'Webhook authentication failed.');
    const headers = headersSchema.safeParse({
      id: inputHeaders['x-webhook-id'],
      timestamp: inputHeaders['x-webhook-timestamp'],
      signature: inputHeaders['x-webhook-signature'],
    });
    if (
      !headers.success ||
      !rawBody ||
      Math.abs(Date.now() / 1000 - Number(headers.data.timestamp)) > 300
    )
      throw denied();
    let record: unknown;
    try {
      record = await this.database.store.integration(headers.data.id);
    } catch {
      throw unavailable();
    }
    if (!record) throw denied();
    const integration = integrationSchema.parse(record);
    let secret: string;
    try {
      secret = unseal(
        integration.encryptedSecret,
        this.env.API_SECRET_KEY,
        `resolvehub:webhook:${integration.id}`,
      );
    } catch {
      throw unavailable();
    }
    const expected = createHmac('sha256', secret)
      .update(headers.data.timestamp)
      .update('.')
      .update(rawBody)
      .digest();
    const provided = Buffer.from(headers.data.signature.slice(3), 'hex');
    if (!timingSafeEqual(expected, provided)) throw denied();
    return { id: integration.id, organizationId: integration.organizationId };
  }
}
