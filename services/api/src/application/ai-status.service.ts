import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { aiStatusEnvelopeSchema, aiFailureMessage } from '@resolvehub/contracts';
import type { AiProviderStatus } from '@resolvehub/contracts';
import { API_ENV } from '../env.js';
import type { ApiEnv } from '../env.js';
import { ApiFault } from './fault.js';

@Injectable()
export class AiStatusService {
  private readonly redis: Redis;
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.redis = new Redis(env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 1500,
    });
    this.redis.on('error', () => undefined);
  }
  async status(organizationId: string): Promise<AiProviderStatus> {
    const unavailable: AiProviderStatus = {
      mode: 'unavailable',
      provider: this.env.DRAFT_PROVIDER,
      model:
        this.env.DRAFT_PROVIDER === 'gemini'
          ? 'gemini-2.5-flash-lite'
          : this.env.DRAFT_PROVIDER === 'mock'
            ? 'resolvehub-extractive-mock-v1'
            : 'operator-configured',
      embeddingModel: 'resolvehub-synthetic-sha256-v1',
      canGenerate: false,
      freeTierVerified: false,
      reasonCode: 'GEMINI_UNAVAILABLE',
      message: 'The AI worker is unavailable. Your support records are saved.',
      retryAfterSeconds: null,
      lastSuccessfulAt: null,
    };
    try {
      const value = await this.redis.get(`${this.env.INGESTION_QUEUE_PREFIX}:ai:status`);
      if (!value) return unavailable;
      const envelope = aiStatusEnvelopeSchema.parse(JSON.parse(value));
      if (envelope.status.provider !== this.env.DRAFT_PROVIDER) return unavailable;
      if (
        envelope.status.provider === 'gemini' &&
        !envelope.syntheticOrganizations.includes(organizationId)
      )
        return {
          ...unavailable,
          reasonCode: 'GEMINI_SYNTHETIC_SCOPE_REQUIRED',
          message: aiFailureMessage('GEMINI_SYNTHETIC_SCOPE_REQUIRED'),
        };
      return envelope.status;
    } catch {
      return unavailable;
    }
  }
  async requireAvailable(organizationId: string) {
    if (this.env.DRAFT_PROVIDER !== 'gemini') return;
    const status = await this.status(organizationId);
    if (!status.canGenerate)
      throw new ApiFault(
        [
          'GEMINI_QUOTA_EXHAUSTED',
          'GEMINI_MINUTE_LIMIT',
          'GEMINI_DAILY_LIMIT',
          'GEMINI_BUSY',
        ].includes(status.reasonCode ?? '')
          ? 429
          : 503,
        status.reasonCode ?? 'GEMINI_UNAVAILABLE',
        status.message,
        status.retryAfterSeconds ? { retryAfterSeconds: status.retryAfterSeconds } : undefined,
      );
  }
  onModuleDestroy() {
    this.redis.disconnect();
  }
}
