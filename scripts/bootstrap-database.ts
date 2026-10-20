import { parseArgs } from 'node:util';
import { createDatabase, migrate, parseEmbeddingConfiguration } from '@resolvehub/db';
import { seedSynthetic } from '../packages/db/seeds/seed.js';

// Creates a NEW local database. Never drops, clears or reuses an existing DB.
const { values } = parseArgs({
  options: { database: { type: 'string' }, seed: { type: 'boolean', default: false } },
});
if (process.env.NODE_ENV === 'production')
  throw new Error('Local bootstrap is disabled in production');
parseEmbeddingConfiguration(process.env);
const name = values.database;
if (!name || !/^resolvehub_[a-z0-9_]{1,48}$/.test(name))
  throw new Error('Use --database resolvehub_<new_name>');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const target = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
  throw new Error('Bootstrap requires a local database');
target.pathname = '/postgres';
const admin = createDatabase(target.toString()).pool;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
} finally {
  await admin.end();
}
target.pathname = `/${name}`;
const pool = createDatabase(target.toString()).pool;
try {
  await migrate(pool, new URL('../packages/db/migrations/', import.meta.url));
  if (values.seed) await seedSynthetic(pool);
  console.info(
    `Bootstrapped ${name}${values.seed ? ' with synthetic fixtures' : ''}. Set DATABASE_URL to use it.`,
  );
} catch {
  throw new Error(
    `Bootstrap failed. The new database ${name} was retained for inspection; repair or remove it explicitly.`,
  );
} finally {
  await pool.end();
}
