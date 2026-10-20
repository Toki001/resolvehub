import type pg from 'pg';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

// SET LOCAL never leaks tenant context when a pooled connection is reused.
export async function tenantTransaction<T>(
  pool: pg.Pool,
  organizationId: string,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tenant = z.uuid().parse(organizationId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('resolvehub.organization_id',$1,true)", [tenant]);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function tenantDrizzle<T>(
  pool: pg.Pool,
  organizationId: string,
  action: (db: ReturnType<typeof database>) => Promise<T>,
) {
  return tenantTransaction(pool, organizationId, (client) => action(database(client)));
}
function database(client: pg.PoolClient) {
  return drizzle(client, { schema });
}

export class TenantConnection {
  constructor(
    private readonly pool: pg.Pool,
    private readonly organizationId: string,
  ) {
    z.uuid().parse(organizationId);
  }
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
    return tenantTransaction(this.pool, this.organizationId, (client) =>
      client.query<T>(text, values),
    );
  }
}
