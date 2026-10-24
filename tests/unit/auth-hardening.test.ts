import 'reflect-metadata';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { WebhookAuthService } from '../../services/api/src/auth/webhook-auth.service.js';
import { DatabaseService } from '../../services/api/src/application/database.service.js';
import { API_ENV, parseApiEnv } from '../../services/api/src/env.js';
import { fingerprint, tokenDigest, seal, unseal } from '../../services/api/src/auth/crypto.js';

const env = parseApiEnv({
  WEB_ORIGIN: 'http://localhost:3000',
  API_SECRET_KEY: 'a'.repeat(64),
  DATABASE_URL: 'postgresql://localhost/synthetic',
  REDIS_URL: 'redis://localhost',
  S3_ENDPOINT: 'http://localhost:9000',
});
const integration = jest.fn<(id: string) => Promise<unknown>>();
const modulePromise = Test.createTestingModule({
  providers: [
    WebhookAuthService,
    { provide: API_ENV, useValue: env },
    { provide: DatabaseService, useValue: { store: { integration } } },
  ],
}).compile();
afterAll(async () => (await modulePromise).close());

test('undefined idempotency payload has a stable canonical null fingerprint', () => {
  expect(fingerprint(undefined)).toBe(tokenDigest('null'));
  expect(fingerprint({ b: [2, { y: 1, x: 0 }], a: 1 })).toBe(
    fingerprint({ a: 1, b: [2, { x: 0, y: 1 }] }),
  );
});

test('sealed secrets reject malformed envelopes, wrong purpose, wrong keys and tampering', () => {
  const encoded = seal('synthetic secret', env.API_SECRET_KEY, 'purpose');
  expect(unseal(encoded, env.API_SECRET_KEY, 'purpose')).toBe('synthetic secret');
  for (const malformed of ['', 'a.b', 'a.b.c', `${encoded}.extra`])
    expect(() => unseal(malformed, env.API_SECRET_KEY, 'purpose')).toThrow('Invalid sealed value');
  expect(() => unseal(encoded, env.API_SECRET_KEY, 'other-purpose')).toThrow();
  expect(() => unseal(encoded, 'b'.repeat(64), 'purpose')).toThrow();
  const [nonce, body, tag] = encoded.split('.');
  expect(() =>
    unseal(
      `${nonce}.${body}.${tag?.startsWith('A') ? 'B' : 'A'}${tag?.slice(1)}`,
      env.API_SECRET_KEY,
      'purpose',
    ),
  ).toThrow();
});

test.each(['database', 'decryption'])(
  'webhook %s failure denies mutation with a sanitized dependency error',
  async (failure) => {
    const id = randomUUID();
    if (failure === 'database')
      integration.mockRejectedValueOnce(new Error('private connection secret'));
    else
      integration.mockResolvedValueOnce({
        id,
        organizationId: randomUUID(),
        encryptedSecret: 'corrupt',
      });
    await expect(
      (await modulePromise).get(WebhookAuthService).authenticate(
        {
          'x-webhook-id': id,
          'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-webhook-signature': `v1=${'0'.repeat(64)}`,
        },
        Buffer.from('synthetic'),
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'A required service is unavailable.',
    });
    expect(integration).toHaveBeenCalledWith(id);
  },
);
