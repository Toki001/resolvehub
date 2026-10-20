import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export { migrate } from './migrate.js';
export { ContractStore, TenantRepository, StoreConflict } from './store.js';
export type { MutationReceipt, Actor, PageWindow, TicketFilter } from './store.js';
export const CONTRACT_MIGRATION = '0002_replay_and_review_integrity.sql';

// Pool lifecycle belongs to the owning service; no process-global connections.
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2_000,
  });
  return { db: drizzle(pool), pool };
}
