import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ContractStore, createDatabase } from '@resolvehub/db';
import { API_ENV } from '../env.js';
import type { ApiEnv } from '../env.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly database;
  readonly store;
  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.database = createDatabase(env.DATABASE_URL);
    this.database.pool.on('error', () => console.warn('Database connection interrupted'));
    this.store = new ContractStore(this.database.pool);
  }
  async onModuleDestroy() {
    await this.database.pool.end();
  }
}
