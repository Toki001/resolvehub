import { parseApiEnv } from '../../services/api/src/env.js';
import { parseWorkerEnv } from '../../services/worker/src/env.js';
import { parseWebEnv } from '../../apps/web/src/lib/env.js';

const storage = {
  DATABASE_URL: 'postgresql://test:test@localhost/db',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'synthetic',
  S3_SECRET_ACCESS_KEY: 'synthetic',
};
const api = {
  API_SECRET_KEY: '1'.repeat(64),
  DATABASE_URL: 'postgresql://user:do-not-log@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  WEB_ORIGIN: 'http://localhost:3000',
};

describe('startup environment validation', () => {
  test('accepts required values and applies bounded defaults', () => {
    expect(parseApiEnv(api).API_PORT).toBe(3001);
    expect(
      parseWorkerEnv({ ...storage, REDIS_URL: api.REDIS_URL, AI_PROVIDER: 'mock' })
        .WORKER_CONCURRENCY,
    ).toBe(2);
    expect(parseWebEnv({}).API_URL).toBe('http://127.0.0.1:3001');
  });
  test.each(['0', '-1', '65536', 'NaN'])('rejects invalid port %s', (port) => {
    expect(() => parseApiEnv({ ...api, API_PORT: port })).toThrow('API_PORT');
  });
  test('errors identify fields without reflecting secret values', () => {
    expect(() => parseApiEnv({ ...api, DATABASE_URL: 'do-not-log' })).toThrow('DATABASE_URL');
    try {
      parseApiEnv({ ...api, DATABASE_URL: 'do-not-log' });
    } catch (error) {
      expect(String(error)).not.toContain('do-not-log');
    }
  });
  test('rejects wrong protocols and origins containing paths', () => {
    expect(() => parseApiEnv({ ...api, REDIS_URL: 'https://localhost' })).toThrow('REDIS_URL');
    expect(() => parseApiEnv({ ...api, WEB_ORIGIN: 'http://localhost/app' })).toThrow('WEB_ORIGIN');
    expect(() => parseWebEnv({ API_URL: 'file:///etc/passwd' })).toThrow('API_URL');
  });
  test('worker rejects unbounded concurrency and unavailable providers', () => {
    expect(() =>
      parseWorkerEnv({
        ...storage,
        REDIS_URL: api.REDIS_URL,
        AI_PROVIDER: 'mock',
        WORKER_CONCURRENCY: '99',
      }),
    ).toThrow('WORKER_CONCURRENCY');
    expect(() =>
      parseWorkerEnv({ ...storage, REDIS_URL: api.REDIS_URL, AI_PROVIDER: 'live' }),
    ).toThrow('AI_PROVIDER');
  });
  test('required dependencies cannot be omitted', () => {
    expect(() => parseApiEnv({})).toThrow('DATABASE_URL');
    expect(() => parseWorkerEnv({})).toThrow('REDIS_URL');
  });
});

test('startup identifies mismatched embedding fields without reflecting supplied values', () => {
  expect(() => parseApiEnv({ ...api, EMBEDDING_MODEL: 'untrusted-config-value' })).toThrow(
    'Invalid API environment: EMBEDDING_MODEL, EMBEDDING_DIMENSIONS',
  );
  expect(() =>
    parseWorkerEnv({
      ...storage,
      REDIS_URL: api.REDIS_URL,
      AI_PROVIDER: 'mock',
      EMBEDDING_DIMENSIONS: '1536',
    }),
  ).toThrow('Invalid worker environment: EMBEDDING_MODEL, EMBEDDING_DIMENSIONS');
});
