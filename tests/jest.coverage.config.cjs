module.exports = {
  ...require('./jest.integration.config.cjs'),
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.ts',
    '<rootDir>/tests/contract/**/*.test.ts',
    '<rootDir>/tests/integration/**/*.test.ts',
  ],
  collectCoverage: true,
  collectCoverageFrom: [
    'services/api/src/auth/**/*.ts',
    'services/api/src/application/**/*.ts',
    'services/worker/src/ingestion/**/*.ts',
    'packages/db/src/{store,ingestion,knowledge,tenant,ticket-status}.ts',
    'packages/ai/src/**/*.ts',
  ],
  coverageThreshold: {
    global: { branches: 80 },
    './services/api/src/auth/': { branches: 80 },
    './services/api/src/application/': { branches: 80 },
    './services/worker/src/ingestion/': { branches: 80 },
    './packages/db/src/': { branches: 80 },
    './packages/ai/src/': { branches: 80 },
  },
};
