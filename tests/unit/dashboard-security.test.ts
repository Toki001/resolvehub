import { sameOrigin, localDemoAllowed } from '../../apps/web/src/lib/action-policy.js';
import { UploadsService } from '../../services/api/src/application/uploads.service.js';
import { parseApiEnv } from '../../services/api/src/env.js';

test.each([
  ['https://support.example.test', 'support.example.test', true],
  ['http://localhost:3000', 'localhost:3000', true],
  ['https://attacker.example', 'support.example.test', false],
  ['https://support.example.test.attacker.example', 'support.example.test', false],
  ['https://support.example.test/path', 'support.example.test', false],
  [null, 'support.example.test', false],
  ['not-a-url', null, false],
  ['javascript:alert(1)', 'support.example.test', false],
])('dashboard mutation origin policy: %s / %s', (origin, host, allowed) =>
  expect(sameOrigin(origin, host)).toBe(allowed),
);
test('local bootstrap cannot become a production or public-host authentication fallback', () => {
  const env = { NODE_ENV: 'development', DASHBOARD_LOCAL_DEMO: 'true' };
  expect(localDemoAllowed(env, 'localhost:3000')).toBe(true);
  expect(localDemoAllowed(env, '127.0.0.1:3000')).toBe(true);
  expect(localDemoAllowed({ ...env, NODE_ENV: 'production' }, 'localhost:3000')).toBe(false);
  expect(localDemoAllowed({ ...env, DASHBOARD_LOCAL_DEMO: 'false' }, 'localhost:3000')).toBe(false);
  expect(localDemoAllowed(env, 'support.example.test:3000')).toBe(false);
  expect(localDemoAllowed(env, null)).toBe(false);
});
test('upload storage fails closed when credentials are absent and destroys its resources', async () => {
  const env = parseApiEnv({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    API_SECRET_KEY: 'a'.repeat(64),
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    WEB_ORIGIN: 'http://localhost:3000',
  });
  const uploads = new UploadsService(env);
  try {
    await expect(uploads.put('test', 'key', Buffer.from('test'), 'text/plain')).rejects.toThrow(
      'not configured',
    );
  } finally {
    uploads.onModuleDestroy();
  }
});
