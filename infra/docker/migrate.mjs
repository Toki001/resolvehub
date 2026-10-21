import { createDatabase, migrate } from '@resolvehub/db';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(process.env.DATABASE_URL);
try {
  const applied = await migrate(pool, new URL('./migrations/', import.meta.url));
  if (process.argv.includes('--grants')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of ['runtime-grants.sql', 'worker-grants.sql'])
        await client.query(await readFile(new URL(`./grants/${file}`, import.meta.url), 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.info(
    applied.length ? `Applied: ${applied.join(', ')}` : 'Database migrations already current',
  );
} catch {
  console.error('Migration or grants failed; deployment stopped. Inspect administrator logs.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
