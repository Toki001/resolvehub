import { createDatabase, migrate } from '@resolvehub/db';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(process.env.DATABASE_URL);
try {
  const applied = await migrate(pool, new URL('../packages/db/migrations/', import.meta.url));
  console.info(
    applied.length ? `Applied: ${applied.join(', ')}` : 'Database migrations already current',
  );
} finally {
  await pool.end();
}
