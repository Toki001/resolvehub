module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  testTimeout: 20_000,
};
