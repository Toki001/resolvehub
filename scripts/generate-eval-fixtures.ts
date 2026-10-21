import { writeFile } from 'node:fs/promises';
import { buildEvaluationFixtures } from '../packages/ai/evals/fixtures.js';
const fixtures = buildEvaluationFixtures();
await writeFile(
  'packages/ai/evals/golden.jsonl',
  fixtures.cases.map((row) => JSON.stringify(row)).join('\n') + '\n',
);
await writeFile(
  'packages/ai/evals/corpus.jsonl',
  fixtures.corpus.map((row) => JSON.stringify(row)).join('\n') + '\n',
);
console.info(
  `Wrote ${fixtures.cases.length} synthetic cases and ${fixtures.corpus.length} corpus versions.`,
);
