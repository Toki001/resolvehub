import { mkdir, writeFile } from 'node:fs/promises';
import { discoverGeminiModels, parseGeminiConfig, GeminiFailure } from '@resolvehub/ai';

if (!process.argv.includes('--live') || process.env.CI || process.env.GITHUB_ACTIONS)
  throw new Error('Model metadata discovery requires explicit --live outside CI');
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  generationCalls: 0,
};
try {
  Object.assign(report, await discoverGeminiModels(parseGeminiConfig(process.env)), {
    status: 'passed',
    billingVerification: 'Existing manual key-bound assertion; model listing is not quota proof.',
  });
} catch (error) {
  report.status = 'failed';
  report.reasonCode =
    error instanceof GeminiFailure ? error.category : 'GEMINI_DISCOVERY_UNAVAILABLE';
  process.exitCode = 1;
}
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/gemini-model-discovery.json',
  JSON.stringify(report, null, 2) + '\n',
  {
    mode: 0o600,
  },
);
console.info(JSON.stringify(report, null, 2));
