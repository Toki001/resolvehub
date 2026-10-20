import { errorSchema, readinessSchema } from '@resolvehub/contracts';

test('readiness requires explicit dependency states', () => {
  expect(
    readinessSchema.safeParse({ service: 'api', status: 'ready', checks: { postgres: 'up' } })
      .success,
  ).toBe(true);
  expect(
    readinessSchema.safeParse({ service: 'api', status: 'ready', checks: { postgres: true } })
      .success,
  ).toBe(false);
  expect(readinessSchema.safeParse({ service: 'api', status: 'ok' }).success).toBe(false);
});

test('API errors must carry a valid request ID', () => {
  expect(errorSchema.safeParse({ code: 'NOT_FOUND', message: 'Not found' }).success).toBe(false);
});
