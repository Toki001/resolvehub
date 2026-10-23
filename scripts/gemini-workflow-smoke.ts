import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { GEMINI_MODEL, geminiEligibility, parseGeminiConfig } from '@resolvehub/ai';

// Explicit manual demo against the reserved synthetic workspace. Ordinary CI
// uses tests/browser/internal-workflow.spec.ts with the offline provider.
if (
  !process.argv.includes('--live') ||
  process.env.GEMINI_LIVE_SMOKE_ENABLED !== 'true' ||
  process.env.CI ||
  process.env.GITHUB_ACTIONS
)
  throw new Error('Live workflow requires explicit opt-in outside CI');
const access = parseGeminiConfig(process.env);
if (
  access.maxAttempts !== 1 ||
  geminiEligibility(access) ||
  !access.organizations.includes('60000000-0000-4000-8000-000000000001')
)
  throw new Error(
    'Current free-tier verification, reserved synthetic scope and GEMINI_MAX_ATTEMPTS=1 on the restarted worker required',
  );
if (
  process.env.DRAFT_PROVIDER !== 'gemini' ||
  process.env.DRAFT_MODEL !== GEMINI_MODEL ||
  process.env.DASHBOARD_LOCAL_DEMO !== 'true' ||
  !process.env.DASHBOARD_LOCAL_DEMO_TOKEN
)
  throw new Error('Explicit local Gemini workspace configuration required');
const origin = new URL(process.env.WEB_ORIGIN ?? '');
const api = new URL(process.env.API_URL ?? '');
if (![origin, api].every((url) => ['localhost', '127.0.0.1'].includes(url.hostname)))
  throw new Error('Local dashboard and API only');
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  model: GEMINI_MODEL,
  status: 'not_run',
  externalDelivery: false,
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const source = 'The milestone ten retention window is 17 days after request.';
const question = 'What is the milestone ten retention window?';
const title = `Synthetic milestone 10 policy ${new Date().toISOString()}`;
async function graph(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(new URL('/graphql', api), {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DASHBOARD_LOCAL_DEMO_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error('Synthetic workflow read failed');
  const body = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await response.json());
  return body.data;
}
try {
  const page = await browser.newPage();
  await page.goto(new URL('/sign-in', origin).href);
  await page.getByRole('button', { name: 'Open local workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  const before = await page.evaluate(async () => {
    const r = await fetch('/api/ai/status');
    return r.json();
  });
  if (
    !z
      .object({
        provider: z.literal('gemini'),
        model: z.literal(GEMINI_MODEL),
        canGenerate: z.literal(true),
        freeTierVerified: z.literal(true),
      })
      .safeParse(before).success
  )
    throw new Error('Gemini unavailable before live request');
  await page.goto(new URL('/knowledge', origin).href);
  await page.getByLabel('Document title', { exact: true }).fill(title);
  await page.getByLabel('Source file', { exact: true }).setInputFiles({
    name: 'synthetic-m10-policy.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Upload & index document', exact: true }).click();
  await expect(
    page.getByText('Index published. This document is available for retrieval.', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const knowledge = z
    .object({
      knowledgeDocuments: z.object({
        edges: z.array(
          z.object({
            node: z.object({
              id: z.string(),
              title: z.string(),
              activeVersionId: z.string().nullable(),
            }),
          }),
        ),
      }),
    })
    .parse(await graph('{knowledgeDocuments(first:100){edges{node{id title activeVersionId}}}}'));
  const document = knowledge.knowledgeDocuments.edges.find((row) => row.node.title === title)?.node;
  if (!document?.activeVersionId) throw new Error('Synthetic document did not publish');
  await page.goto(new URL('/tickets', origin).href);
  await page.getByLabel('Subject', { exact: true }).fill(question);
  await page.getByLabel('Customer email', { exact: true }).fill('milestone-ten@example.test');
  await page.getByLabel('Customer message', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets\/[a-f0-9-]+$/);
  const ticketUrl = page.url(),
    ticketId = ticketUrl.split('/').at(-1);
  const start = performance.now();
  // Exactly one user generation action. No script retry or alternative model.
  await page.getByRole('button', { name: 'Generate support draft', exact: true }).click();
  const review = page
    .locator('.job-progress')
    .getByRole('link', { name: 'Review draft →', exact: true });
  await expect(review).toBeVisible({ timeout: 30000 });
  report.queueAndUiLatencyMs = performance.now() - start;
  await review.click();
  await expect(page).toHaveURL(/\/review\/[a-f0-9-]+$/);
  const draftId = page.url().split('/').at(-1);
  const draft = z
    .object({
      draft: z.object({
        id: z.string(),
        text: z.string(),
        evidenceValidated: z.boolean(),
        citations: z.array(
          z.object({
            documentId: z.string(),
            versionId: z.string(),
            chunkId: z.string(),
            quote: z.string(),
          }),
        ),
        generation: z.object({
          provider: z.string(),
          model: z.string(),
          outcome: z.string(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          tokenCountSource: z.string(),
          estimatedCostUsd: z.number(),
          retrievalLatencyMs: z.number(),
          generationLatencyMs: z.number(),
          totalLatencyMs: z.number(),
          pricing: z.object({ source: z.string(), effectiveDate: z.string() }),
        }),
      }),
    })
    .parse(
      await graph(
        'query($id:ID!){draft(id:$id){id text evidenceValidated citations{documentId versionId chunkId quote} generation{provider model outcome inputTokens outputTokens tokenCountSource estimatedCostUsd retrievalLatencyMs generationLatencyMs totalLatencyMs pricing{source effectiveDate}}}}',
        { id: draftId },
      ),
    ).draft;
  if (
    draft.generation.model !== GEMINI_MODEL ||
    draft.generation.outcome !== 'answer' ||
    !draft.evidenceValidated ||
    draft.citations.length !== 1 ||
    !draft.citations.every(
      (c) =>
        c.documentId === document.id &&
        c.versionId === document.activeVersionId &&
        c.quote === source,
    )
  )
    throw new Error('Live evidence did not match the published synthetic document');
  report.generation = draft.generation;
  report.citations = draft.citations.map(({ documentId, versionId, chunkId }) => ({
    documentId,
    versionId,
    chunkId,
  }));
  const edited = `Thank you for contacting support. ${source} [1]`;
  await page.getByRole('textbox', { name: 'Draft text', exact: true }).fill(edited);
  await page.getByRole('button', { name: 'Save draft changes', exact: true }).click();
  await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve & add to conversation', exact: true }).click();
  await expect(
    page.getByText('Approved for internal use. Review the ticket conversation for reply history.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open ticket conversation →', exact: true }).click();
  await expect(page.locator('.agent-message')).toHaveCount(1);
  await expect(page.locator('.agent-message')).toContainText(edited);
  await expect(page.locator('.agent-message')).toContainText('Internal only');
  const saved = await graph(
    'query($id:ID!){ticket(id:$id){messages{id body author deliveryStatus sourceDraftId}}}',
    { id: ticketId },
  );
  const conversation = z
    .object({
      ticket: z.object({
        messages: z.array(
          z.object({
            body: z.string(),
            author: z.string(),
            deliveryStatus: z.string(),
            sourceDraftId: z.string().nullable(),
          }),
        ),
      }),
    })
    .parse(saved);
  if (
    !conversation.ticket.messages.some(
      (row) =>
        row.author === 'agent' &&
        row.body === edited &&
        row.deliveryStatus === 'internal' &&
        row.sourceDraftId === draftId,
    )
  )
    throw new Error('Approved internal reply was not persisted');
  await page.goto(new URL('/settings', origin).href);
  await expect(
    page.getByRole('link', { name: 'AI provider: Gemini Live', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  report.dashboardMode = 'gemini_live';
  report.editedApprovedAndPersistedInternal = true;
  report.status = 'passed';
} catch {
  report.status = 'failed';
  report.reasonCode = 'LIVE_WORKFLOW_VERIFICATION_FAILED';
  process.exitCode = 1;
} finally {
  await browser.close();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/gemini-workflow-smoke.json',
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.info(JSON.stringify(report, null, 2));
}
