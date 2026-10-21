import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, migrate } from '@resolvehub/db';
import {
  loadEvaluationCorpus,
  readEvaluationFixtures,
  runEvaluation,
} from '../../packages/ai/evals/runner.js';

test('the unchanged 60-case golden suite measures RAG quality, leakage, cost and ten-concurrent latency against pgvector', async () => {
  if (!process.env.DATABASE_URL) throw new Error('Isolated database required');
  const admin = createDatabase(process.env.DATABASE_URL).pool,
    namespace = `rh_eval_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${namespace}`);
  const pool = createDatabase(url.toString(), { maxConnections: 12 }).pool;
  try {
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    await migrate(pool, new URL('../../packages/db/migrations/', import.meta.url));
    const fixtures = await readEvaluationFixtures();
    await loadEvaluationCorpus(pool, fixtures.corpus);
    const report = await runEvaluation(pool);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/ai-evaluation.json', JSON.stringify(report, null, 2) + '\n');
    expect(report.metrics.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.metrics.recallAt5.denominator).toBe(30);
    expect(report.metrics.supportedClaims.denominator).toBeGreaterThan(0);
    expect(report.metrics.correctAbstention.denominator).toBe(30);
    expect(report.metrics.tenantLeakage).toMatchObject({ numerator: 0, denominator: 60 });
    expect(report.environment.concurrency).toBe(10);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await admin.end();
  }
});
