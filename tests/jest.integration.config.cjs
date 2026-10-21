module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/nest-application.ts'],
  testTimeout: 20000,
};
