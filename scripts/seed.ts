import { createDatabase, parseEmbeddingConfiguration } from '@resolvehub/db';
import { seedSynthetic } from '../packages/db/seeds/seed.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Synthetic seed is disabled in production');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
parseEmbeddingConfiguration(process.env);
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Synthetic seed requires a local database');
const { pool } = createDatabase(url.toString());
try {
  console.info('Synthetic fixtures only:', await seedSynthetic(pool));
} finally {
  await pool.end();
}
