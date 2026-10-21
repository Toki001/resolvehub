import { idempotencyKey } from '../../services/api/src/application/policy.js';
import { fingerprint } from '../../services/api/src/auth/crypto.js';

test.each([16, 128])('idempotency keys accept the %i-character boundary', (size) => {
  expect(idempotencyKey.parse('a'.repeat(size))).toHaveLength(size);
});
test.each([
  undefined,
  null,
  42,
  '',
  'a'.repeat(15),
  'a'.repeat(129),
  'has spaces______',
  'header\r\ninjection',
  'é'.repeat(16),
  'a'.repeat(16) + '\n',
  'a'.repeat(16) + '\r',
])('unsafe or unbounded key is rejected: %s', (key) => {
  expect(idempotencyKey.safeParse(key).success).toBe(false);
});
test('payload fingerprints normalize nested objects, preserve array order and distinguish scalar types', () => {
  expect(fingerprint({ b: [{ y: 2, x: null }], a: true })).toBe(
    fingerprint({ a: true, b: [{ x: null, y: 2 }] }),
  );
  expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  expect(fingerprint({ value: '1' })).not.toBe(fingerprint({ value: 1 }));
});
