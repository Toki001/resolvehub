import type { Redis } from 'ioredis';
import { IngestionFailure, sleep } from './failure.js';

// One atomic Redis window for every worker using this provider/model.
const script = `local n=tonumber(redis.call('GET',KEYS[1]) or '0'); if n>=tonumber(ARGV[1]) then return redis.call('PTTL',KEYS[1]); end; n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[2]); end; return 0;`;
export class ProviderLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly max: number,
    private readonly duration = 1000,
  ) {}
  async acquire(signal: AbortSignal) {
    while (!signal.aborted) {
      let wait: unknown;
      try {
        wait = await this.redis.eval(script, 1, this.key, this.max, this.duration);
      } catch {
        throw new IngestionFailure('REDIS_UNAVAILABLE');
      }
      if (typeof wait !== 'number') throw new IngestionFailure('REDIS_UNAVAILABLE');
      if (wait === 0) return;
      await sleep(Math.max(1, wait), signal);
    }
    throw new IngestionFailure('WORKER_INTERRUPTED');
  }
}
