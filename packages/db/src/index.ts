import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

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
