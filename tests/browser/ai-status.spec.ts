import { expect, test } from '@playwright/test';

test('provider status updates to unavailable after a failed status request without retaining a live badge', async ({
  page,
}) => {
  let unavailable = false;
  await page.route('**/api/ai/status', (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { code: 'DEPENDENCY_UNAVAILABLE' } })
      : route.fulfill({
          status: 200,
          json: {
            mode: 'gemini_live',
            provider: 'gemini',
            model: 'gemini-3.5-flash-lite',
            embeddingModel: 'resolvehub-synthetic-sha256-v1',
            canGenerate: true,
            freeTierVerified: true,
            reasonCode: null,
            message: 'Synthetic browser fixture: provider verified.',
            retryAfterSeconds: null,
            lastSuccessfulAt: '2026-10-21T00:00:00Z',
          },
        }),
  );
  await page.goto('/settings');
  await expect(
    page.getByRole('link', { name: 'AI provider: Gemini Live', exact: true }),
  ).toBeVisible();
  unavailable = true;
  await page.goto('/tickets');
  await expect(
    page.getByRole('link', { name: 'AI provider: Unavailable', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'AI provider: Gemini Live', exact: true }),
  ).toHaveCount(0);
});
