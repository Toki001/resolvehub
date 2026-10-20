import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Readiness } from '@resolvehub/contracts';
import { Redis } from 'ioredis';
import { API_ENV } from './env.js';
import type { ApiEnv } from './env.js';
import { DatabaseService } from './application/database.service.js';
import { CONTRACT_MIGRATION, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@resolvehub/db';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly database;
  private readonly redis;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) databaseService: DatabaseService,
  ) {
    this.database = databaseService.database;
    this.redis = new Redis(env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
    });
    this.redis.on('error', () => this.logger.warn('Redis connection interrupted'));
  }

  async readiness(): Promise<Readiness> {
    const results = await Promise.allSettled([
      this.database.pool
        .query(
          "SELECT extversion FROM pg_extension WHERE extname = 'vector' AND EXISTS (SELECT 1 FROM schema_migrations WHERE name=$1) AND EXISTS (SELECT 1 FROM embedding_configuration WHERE model=$2 AND dimensions=$3)",
          [CONTRACT_MIGRATION, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS],
        )
        .then((result) => {
          if (result.rowCount !== 1) throw new Error('Required extension unavailable');
        }),
      this.redis.ping().then((reply) => {
        if (reply !== 'PONG') throw new Error('Unexpected Redis response');
      }),
      fetch(new URL('/minio/health/ready', this.env.S3_ENDPOINT), {
        signal: AbortSignal.timeout(2_000),
      }).then((response) => {
        if (!response.ok) throw new Error('Storage unavailable');
      }),
    ]);
    const [postgres, redis, storage] = results.map((result) =>
      result.status === 'fulfilled' ? ('up' as const) : ('down' as const),
    );
    const checks = {
      postgres: postgres ?? 'down',
      redis: redis ?? 'down',
      storage: storage ?? 'down',
    };
    return {
      service: 'api',
      status: Object.values(checks).every((status) => status === 'up') ? 'ready' : 'not_ready',
      checks,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
