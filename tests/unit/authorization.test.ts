import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { AuthService } from '../../services/api/src/auth/auth.service.js';
import { AuthGuard } from '../../services/api/src/auth/auth.guard.js';
import { identityOf } from '../../services/api/src/auth/context.js';
import type { Identity } from '../../services/api/src/auth/context.js';
import { DatabaseService } from '../../services/api/src/application/database.service.js';
import { ContractValidator } from '../../services/api/src/application/validator.js';
import { requireWriteAccess } from '../../services/api/src/application/policy.js';
import { tokenDigest } from '../../services/api/src/auth/crypto.js';

const identity: Identity = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  membershipId: '10000000-0000-4000-8000-000000000002',
  subject: 'synthetic@example.test',
  role: 'admin',
};
const token = `rh_${'a'.repeat(43)}`;
const authenticate = jest.fn<(hash: string) => Promise<unknown>>();
const modulePromise = Test.createTestingModule({
  providers: [
    AuthService,
    AuthGuard,
    ContractValidator,
    { provide: DatabaseService, useValue: { store: { authenticate } } },
  ],
}).compile();
afterAll(async () => {
  await (await modulePromise).close();
});
beforeEach(() => {
  authenticate.mockReset().mockResolvedValue(identity);
});

test.each([
  undefined,
  '',
  'Bearer bad',
  `Basic ${token}`,
  `bearer ${token}`,
  `Bearer ${token} extra`,
])('malformed authorization is rejected before database access: %s', async (header) => {
  await expect((await modulePromise).get(AuthService).authenticate(header)).rejects.toMatchObject({
    statusCode: 401,
  });
  expect(authenticate).not.toHaveBeenCalled();
});
test('verified credential determines tenant; only its digest reaches storage', async () => {
  expect(await (await modulePromise).get(AuthService).authenticate(`Bearer ${token}`)).toEqual(
    identity,
  );
  expect(authenticate).toHaveBeenCalledWith(tokenDigest(token));
});
test('missing or revoked credentials fail closed', async () => {
  authenticate.mockResolvedValue(undefined);
  await expect(
    (await modulePromise).get(AuthService).authenticate(`Bearer ${token}`),
  ).rejects.toMatchObject({ statusCode: 401 });
});
test('database downtime yields a safe dependency failure', async () => {
  authenticate.mockRejectedValue(new Error('password=never-expose'));
  await expect(
    (await modulePromise).get(AuthService).authenticate(`Bearer ${token}`),
  ).rejects.toMatchObject({ statusCode: 503, message: 'A required service is unavailable.' });
});
test('corrupt stored identity cannot authorize a request', async () => {
  authenticate.mockResolvedValue({ ...identity, role: 'owner' });
  await expect(
    (await modulePromise).get(AuthService).authenticate(`Bearer ${token}`),
  ).rejects.toMatchObject({ statusCode: 500 });
});
test.each(['http', 'graphql'])(
  'guard replaces forged identity and shares authentication across %s fields',
  async (transport) => {
    const request = {
      headers: { authorization: `Bearer ${token}` },
      identity: { ...identity, organizationId: 'forged' },
    };
    const context = new ExecutionContextHost(
      transport === 'http' ? [request, {}, () => undefined] : [null, {}, { req: request }, {}],
    );
    context.setType(transport);
    const guard = (await modulePromise).get(AuthGuard);
    expect(await Promise.all([guard.canActivate(context), guard.canActivate(context)])).toEqual([
      true,
      true,
    ]);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(request.identity).toEqual(identity);
  },
);
test.each(['admin', 'agent', 'analyst'] as const)('write and admin permissions for %s', (role) => {
  const actor = { ...identity, role };
  if (role === 'analyst') expect(() => requireWriteAccess(actor)).toThrow('Access is denied');
  else expect(() => requireWriteAccess(actor)).not.toThrow();
  if (role === 'admin') expect(() => requireWriteAccess(actor, true)).not.toThrow();
  else expect(() => requireWriteAccess(actor, true)).toThrow('Access is denied');
});

test('identity lookup fails closed unless authentication populated it', () => {
  expect(() => identityOf({})).toThrow('Authentication is required');
  expect(identityOf({ identity })).toBe(identity);
});
