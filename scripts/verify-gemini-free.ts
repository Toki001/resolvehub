import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { GEMINI_MODEL, geminiEligibility, parseGeminiConfig } from '@resolvehub/ai';

// Records an OPERATOR assertion, never discovers billing from a successful key.
// This utility makes no Google requests and cannot change an account or billing.
const args = process.argv.slice(2);
function argument(name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
if (
  !['--confirm-free-tier', '--confirm-billing-disabled', '--confirm-synthetic-only'].every((flag) =>
    args.includes(flag),
  )
)
  throw new Error(
    'Manual AI Studio verification required: --confirm-free-tier --confirm-billing-disabled --confirm-synthetic-only, --project ID, --model and --organization UUID',
  );
const apiKey = z.string().min(20).parse(process.env.GEMINI_API_KEY);
const project = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,62}$/)
  .parse(argument('--project'));
const organization = z.uuid().parse(argument('--organization'));
const model = z.literal(GEMINI_MODEL).parse(argument('--model'));
const values = {
  DRAFT_PROVIDER: 'gemini',
  DRAFT_MODEL: model,
  GEMINI_FREE_TIER_MODEL: model,
  GEMINI_PROJECT_ID: project,
  GEMINI_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
  GEMINI_FREE_TIER_KEY_SHA256: createHash('sha256').update(apiKey).digest('hex'),
  GEMINI_FREE_TIER_CONFIRMED: 'true',
  GEMINI_BILLING_DISABLED: 'true',
  GEMINI_SYNTHETIC_ONLY: 'true',
  GEMINI_SYNTHETIC_ORGANIZATION_IDS: organization,
  DRAFT_INPUT_USD_PER_MILLION: '0',
  DRAFT_OUTPUT_USD_PER_MILLION: '0',
  DRAFT_MAX_PROMPT_TOKENS: '4096',
  DRAFT_MAX_OUTPUT_TOKENS: '512',
};
const config = parseGeminiConfig({ ...process.env, ...values });
if (geminiEligibility(config)) throw new Error('Gemini verification remains incomplete');
let contents = await readFile('.env', 'utf8');
for (const [name, value] of Object.entries(values)) {
  const line = new RegExp(`^${name}=.*$`, 'm');
  contents = line.test(contents)
    ? contents.replace(line, `${name}=${value}`)
    : `${contents.trimEnd()}\n${name}=${value}\n`;
}
await writeFile('.env', contents, { mode: 0o600 });
await chmod('.env', 0o600);
console.info(
  'Recorded a 24-hour key-bound MANUAL Free Tier / billing-disabled assertion for the synthetic workspace. No API or billing request was made. Restart API and worker. No Gemini embeddings were enabled.',
);
