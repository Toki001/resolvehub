import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { z } from 'zod';
const config = process.env.RESOLVEHUB_DASHBOARD_TEST_CONFIG;
const fixtures = config
  ? z
      .object({
        credentials: z.object({ adminA: z.string(), adminB: z.string(), analyst: z.string() }),
        tickets: z.object({ a: z.string(), b: z.string() }),
      })
      .parse(JSON.parse(readFileSync(config, 'utf8')))
  : null;
test.skip(!fixtures, 'Use pnpm test:dashboard for isolated authenticated browser fixtures');
test.describe.configure({ mode: 'serial' });
async function login(page: Page, key: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Access key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets$/);
}
async function createTicket(page: Page) {
  await page.goto('/tickets');
  await page.getByLabel('Subject', { exact: true }).fill('What is the refund window?');
  await page.getByLabel('Customer email', { exact: true }).fill('synthetic-customer@example.test');
  await page.getByLabel('Customer message', { exact: true }).fill('What is the refund window?');
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets\/[a-f0-9-]+$/);
  return page.url();
}
async function draft(page: Page) {
  await page.getByRole('button', { name: 'Generate support draft', exact: true }).click();
  const link = page
    .locator('.job-progress')
    .getByRole('link', { name: 'Review draft →', exact: true });
  await expect(link).toBeVisible({ timeout: 30000 });
  await link.click();
  await expect(page).toHaveURL(/\/review\/[a-f0-9-]+$/);
}

test('upload → cited draft → edit → approve → internal conversation; rejection and customer context work', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  if (!fixtures) throw new Error('Missing isolated fixtures');
  await login(page, fixtures.credentials.adminA);
  const session = (await page.context().cookies()).find((c) => c.name === 'rh_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.goto('/knowledge');
  await page
    .getByLabel('Document title', { exact: true })
    .fill(`Synthetic refund policy ${testInfo.project.name}`);
  await page.getByLabel('Source file', { exact: true }).setInputFiles({
    name: 'refund-policy.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('The refund window is 14 days after payment.'),
  });
  await page.getByRole('button', { name: 'Upload & index document', exact: true }).click();
  await expect(
    page.getByText('Index published. This document is available for retrieval.', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const ticketUrl = await createTicket(page);
  await draft(page);
  await expect(page.getByRole('textbox', { name: 'Draft text', exact: true })).toHaveValue(
    /14 days/,
  );
  await expect(page.getByText(/Local mock provider/)).toBeVisible();
  const edited = 'Thank you for getting in touch. The refund window is 14 days after payment. [1]';
  await page.getByRole('textbox', { name: 'Draft text', exact: true }).fill(edited);
  await page.getByRole('button', { name: 'Save draft changes', exact: true }).click();
  await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
  await expect(page.getByText(/Edited by an agent/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve & add to conversation', exact: true }).click();
  await expect(
    page.getByText('Approved for internal use. Review the ticket conversation for reply history.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open ticket conversation →', exact: true }).click();
  await expect(page).toHaveURL(ticketUrl);
  await expect(page.locator('.agent-message')).toHaveCount(1);
  await expect(page.locator('.agent-message')).toContainText(edited);
  await expect(page.locator('.agent-message')).toContainText('Internal only');
  await page.screenshot({ path: testInfo.outputPath('internal-conversation.png'), fullPage: true });
  await page.getByLabel('Customer message', { exact: true }).fill('What is the refund window?');
  await page.getByRole('button', { name: 'Record customer message', exact: true }).click();
  await expect(page.locator('.message').filter({ hasText: 'Customer message' })).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('resolve');
  await page.getByRole('button', { name: 'Update status', exact: true }).click();
  await expect(page.locator('.page-heading .status-pill')).toHaveText('resolved');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reopen');
  await page.getByRole('button', { name: 'Update status', exact: true }).click();
  await expect(page.locator('.page-heading .status-pill')).toHaveText('open');
  const rejectedTicket = await createTicket(page);
  await draft(page);
  await page.getByText('Reject this draft', { exact: true }).click();
  await page
    .getByLabel('Rejection reason', { exact: true })
    .fill('Needs a clearer explanation for this customer.');
  await page.getByRole('button', { name: 'Reject draft', exact: true }).click();
  await expect(
    page.getByText('This draft was rejected. No reply was recorded.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Reason: Needs a clearer explanation for this customer.', { exact: true }),
  ).toBeVisible();
  await page.goto(rejectedTicket);
  await expect(page.locator('.agent-message')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('a later draft does not show an earlier success when job polling fails, and retry only resumes polling', async ({
  page,
}) => {
  test.setTimeout(60000);
  if (!fixtures) throw new Error('Missing isolated fixtures');
  await login(page, fixtures.credentials.adminA);
  await createTicket(page);
  const request = page.getByRole('button', { name: 'Generate support draft', exact: true });
  const progress = page.locator('.job-progress');
  const review = progress.getByRole('link', { name: 'Review draft →', exact: true });
  await request.click();
  await expect(review).toBeVisible({ timeout: 30000 });
  const earlier = await review.getAttribute('href');
  if (!earlier) throw new Error('The completed draft has no review link');
  await page.route('**/api/jobs/*', (route) =>
    route.fulfill({ status: 503, json: { code: 'DEPENDENCY_UNAVAILABLE' } }),
  );
  await request.click();
  await expect(progress.getByRole('alert')).toContainText('Job status is unavailable.');
  await expect(progress.locator('strong')).toHaveText('Background job: accepted');
  await expect(review).toHaveCount(0);
  await page.unroute('**/api/jobs/*');
  await progress.getByRole('button', { name: 'Check job again', exact: true }).click();
  await expect(review).toBeVisible({ timeout: 30000 });
  await expect(review).not.toHaveAttribute('href', earlier);
});
test('read-only membership cannot use write controls, and switching tenants clears private records', async ({
  page,
}) => {
  if (!fixtures) throw new Error('Missing isolated fixtures');
  await login(page, fixtures.credentials.analyst);
  await expect(page.getByRole('button', { name: 'Create ticket', exact: true })).toHaveCount(0);
  await page.goto(`/tickets/${fixtures.tickets.a}`);
  await expect(
    page.getByRole('button', { name: 'Generate support draft', exact: true }),
  ).toHaveCount(0);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await login(page, fixtures.credentials.adminB);
  await expect(page.getByText('PRIVATE_ORGANIZATION_B_TICKET', { exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE_ORGANIZATION_A_TICKET', { exact: true })).toHaveCount(0);
  await page.goto(`/tickets/${fixtures.tickets.a}`);
  await expect(page.getByText('Resource was not found.', { exact: true })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'rh_session'),
  ).toBeUndefined();
  await page.goto('/tickets');
  await expect(
    page.getByRole('heading', { name: 'Connect your workspace', exact: true }),
  ).toBeVisible();
});
