import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from '@resolvehub/db';
import {
  loadEvaluationCorpus,
  readEvaluationFixtures,
  runEvaluation,
} from '../packages/ai/evals/runner.js';
if (
  !process.env.DATABASE_URL ||
  process.env.NODE_ENV !== 'test' ||
  process.env.AI_PROVIDER !== 'mock'
)
  throw new Error('Evaluation requires isolated mock infrastructure; use pnpm ai:eval');
const { pool } = createDatabase(process.env.DATABASE_URL, { maxConnections: 12 });
try {
  const fixtures = await readEvaluationFixtures();
  await loadEvaluationCorpus(pool, fixtures.corpus);
  const report = await runEvaluation(pool);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/ai-evaluation.json', JSON.stringify(report, null, 2) + '\n');
  console.info(
    JSON.stringify(
      {
        cases: report.cases,
        provider: report.provider,
        metrics: report.metrics,
        rawSyntheticVectorRecallAt5: report.rawSyntheticVectorRecallAt5,
        latency: report.latency,
        cost: report.cost,
        targets: report.targets,
        passed: report.passed,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
