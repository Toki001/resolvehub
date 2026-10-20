import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export { migrate } from './migrate.js';
export { ContractStore, TenantRepository, StoreConflict } from './store.js';
export type { MutationReceipt, Actor, PageWindow, TicketFilter } from './store.js';
export const CONTRACT_MIGRATION = '0006_preserve_pending_ingestion.sql';

// Pool lifecycle belongs to the owning service; no process-global connections.
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2_000,
  });
  return { db: drizzle(pool, { schema }), pool };
}

export * as schema from './schema.js';
export { KnowledgeRepository } from './knowledge.js';
export { tenantTransaction, tenantDrizzle } from './tenant.js';
export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, parseEmbeddingConfiguration } from './embedding.js';
