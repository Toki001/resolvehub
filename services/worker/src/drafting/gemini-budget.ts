import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { GEMINI_MODEL, geminiEligibility, GeminiFailure } from '@resolvehub/ai';
import type { GeminiBudget, GeminiConfig } from '@resolvehub/ai';
import { aiFailureMessage } from '@resolvehub/contracts';
import type { AiProviderStatus } from '@resolvehub/contracts';

// One atomic budget and lease set per Google project, shared by all replicas.
// Failed/time-out requests remain charged to these conservative rolling windows.
const acquireScript = `
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local blocked=tonumber(redis.call('GET',KEYS[3]) or '0')
if blocked>now then return {4,math.ceil((blocked-now)/1000)} end
local failure=redis.call('GET',KEYS[4])
if failure then local f=cjson.decode(failure); if f['until']>now then return {5,math.ceil((f['until']-now)/1000)} end end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-86400000)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then
 local oldest=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES')
 return {2,math.max(1,math.ceil((tonumber(oldest[2])+86400000-now)/1000))} end
if redis.call('ZCOUNT',KEYS[1],now-60000,'+inf')>=tonumber(ARGV[1]) then return {1,60} end
if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) then return {3,30} end
redis.call('ZADD',KEYS[1],now,ARGV[4]); redis.call('PEXPIRE',KEYS[1],172800000)
redis.call('ZADD',KEYS[2],now+60000,ARGV[4]); redis.call('PEXPIRE',KEYS[2],120000)
return {0,0}`;
export class RedisGeminiBudget implements GeminiBudget {
  private readonly key: string;
  private localBlockUntil = 0;
  constructor(
    private readonly redis: Redis,
    private readonly config: GeminiConfig,
    prefix: string,
  ) {
    this.key = `${prefix}:gemini:${createHash('sha256')
      .update(config.projectId ?? 'unverified')
      .digest('hex')}`;
  }
  async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    const eligibility = geminiEligibility(this.config);
    if (eligibility) throw new GeminiFailure(eligibility);
    if (this.localBlockUntil > Date.now())
      throw new GeminiFailure('GEMINI_QUOTA_EXHAUSTED', this.localBlockUntil - Date.now());
    const lease = randomUUID();
    let result;
    try {
      result = z
        .tuple([z.number().int(), z.number().int()])
        .parse(
          await this.redis.eval(
            acquireScript,
            4,
            `${this.key}:requests`,
            `${this.key}:leases`,
            `${this.key}:blocked`,
            `${this.key}:model:${GEMINI_MODEL}:failure`,
            this.config.requestsPerMinute,
            this.config.requestsPerDay,
            this.config.concurrency,
            lease,
          ),
        );
    } catch {
      throw new GeminiFailure('GEMINI_UNAVAILABLE');
    }
    const [code, seconds] = result;
    if (code !== 0)
      throw new GeminiFailure(
        code === 1
          ? 'GEMINI_MINUTE_LIMIT'
          : code === 2
            ? 'GEMINI_DAILY_LIMIT'
            : code === 3
              ? 'GEMINI_BUSY'
              : code === 4
                ? 'GEMINI_QUOTA_EXHAUSTED'
                : 'GEMINI_UNAVAILABLE',
        seconds * 1000,
      );
    return lease;
  }
  async release(lease: string) {
    try {
      await this.redis.zrem(`${this.key}:leases`, lease);
    } catch {
      /* Lease expires; disconnected Redis cannot admit another call. */
    }
  }
  async failed(failure: GeminiFailure) {
    const delay =
      failure.category === 'GEMINI_QUOTA_EXHAUSTED' || !failure.transient
        ? Math.max(86400000, failure.retryAfterMs)
        : Math.max(1000, failure.retryAfterMs);
    if (failure.category === 'GEMINI_QUOTA_EXHAUSTED') this.localBlockUntil = Date.now() + delay;
    try {
      await this.redis.set(
        `${this.key}:model:${GEMINI_MODEL}:failure`,
        JSON.stringify({ category: failure.category, until: Date.now() + delay }),
        'PX',
        Math.max(86400000, delay),
      );
      if (failure.category === 'GEMINI_QUOTA_EXHAUSTED')
        await this.redis.set(`${this.key}:blocked`, String(this.localBlockUntil), 'PX', delay);
    } catch {
      /* Local quota latch remains closed; Redis admission also fails closed. */
    }
  }
  async succeeded(_inputTokens: number, _outputTokens: number) {
    try {
      await this.redis.set(
        `${this.key}:model:${GEMINI_MODEL}:last-success:${this.config.keySha256}`,
        new Date().toISOString(),
        'EX',
        86400,
      );
      await this.redis.del(`${this.key}:model:${GEMINI_MODEL}:failure`);
    } catch {
      /* Preserve reported usage; missing status heartbeat fails closed. */
    }
  }
  async status(): Promise<AiProviderStatus> {
    const eligibility = geminiEligibility(this.config);
    const base = {
      provider: 'gemini' as const,
      model: GEMINI_MODEL,
      embeddingModel: 'resolvehub-synthetic-sha256-v1',
      lastSuccessfulAt: null,
      freeTierVerified: !eligibility,
    };
    if (eligibility)
      return {
        ...base,
        mode: 'unavailable',
        canGenerate: false,
        reasonCode: eligibility,
        message: aiFailureMessage(eligibility),
        retryAfterSeconds: null,
      };
    const [blocked, failure, success, day, minute, leases] =
      (await this.redis
        .multi()
        .get(`${this.key}:blocked`)
        .get(`${this.key}:model:${GEMINI_MODEL}:failure`)
        .get(`${this.key}:model:${GEMINI_MODEL}:last-success:${this.config.keySha256}`)
        .zcount(`${this.key}:requests`, Date.now() - 86400000, '+inf')
        .zcount(`${this.key}:requests`, Date.now() - 60000, '+inf')
        .zcount(`${this.key}:leases`, Date.now(), '+inf')
        .exec()) ?? [];
    const value = (result: [Error | null, unknown] | undefined) => {
      if (!result || result[0]) throw new Error('Provider status unavailable');
      return result[1];
    };
    const until = Math.max(this.localBlockUntil, Number(value(blocked) ?? 0));
    const problem = value(failure);
    const recent = problem
      ? z
          .object({ category: z.string(), until: z.number() })
          .parse(JSON.parse(z.string().parse(problem)))
      : null;
    const capacityReason =
      until > Date.now()
        ? 'GEMINI_QUOTA_EXHAUSTED'
        : Number(value(day)) >= this.config.requestsPerDay
          ? 'GEMINI_DAILY_LIMIT'
          : Number(value(minute)) >= this.config.requestsPerMinute
            ? 'GEMINI_MINUTE_LIMIT'
            : Number(value(leases)) >= this.config.concurrency
              ? 'GEMINI_BUSY'
              : null;
    const last = value(success);
    const reason = capacityReason ?? recent?.category ?? (!last ? 'GEMINI_NOT_YET_VERIFIED' : null);
    const cooldown = Math.max(0, Math.ceil(((recent?.until ?? 0) - Date.now()) / 1000));
    return {
      ...base,
      lastSuccessfulAt: last ? z.iso.datetime().parse(last) : null,
      mode: reason ? 'unavailable' : 'gemini_live',
      canGenerate: !capacityReason && cooldown === 0,
      reasonCode: reason,
      message: reason
        ? reason === 'GEMINI_NOT_YET_VERIFIED'
          ? 'Gemini is configured for verified free-tier synthetic use; a successful live request has not yet been measured.'
          : aiFailureMessage(reason)
        : 'Gemini text generation is enabled for verified free-tier synthetic use. Infrastructure costs are separate.',
      retryAfterSeconds: capacityReason
        ? until > Date.now()
          ? Math.ceil((until - Date.now()) / 1000)
          : capacityReason === 'GEMINI_DAILY_LIMIT'
            ? 86400
            : 60
        : cooldown || null,
    };
  }
}
