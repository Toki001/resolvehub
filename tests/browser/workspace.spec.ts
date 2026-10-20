import { expect, test } from '@playwright/test';

test('all four workspace pages are navigable and honest about scope', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();
  await expect(page.getByText('Ready for your first conversation')).toBeVisible();
  for (const [label, url] of [
    ['Knowledge Base', '/knowledge'],
    ['Review Queue', '/review'],
    ['Settings', '/settings'],
  ] as const) {
    await page.locator('.sidebar').getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${url}$`));
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByText('All systems connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('All systems connected', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(browserErrors).toEqual([]);
});

test('health failures show a retriable error, never a success state', async ({ page }) => {
  await page.route('**/api/status', (route) => route.abort());
  await page.goto('/settings');
  await expect(
    page.getByText('Health check could not be completed', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
  await expect(page.getByText('All systems connected', { exact: true })).toHaveCount(0);
});

test('keyboard users can skip workspace navigation', async ({ page }) => {
  await page.goto('/tickets');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});
