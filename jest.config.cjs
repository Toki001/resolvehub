module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  coverageProvider: 'v8',
  coverageReporters: ['text', 'json', 'json-summary', 'lcov', 'html'],
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts', '<rootDir>/tests/contract/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          isolatedModules: true,
          experimentalDecorators: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@resolvehub/(contracts|db|ai)$': '<rootDir>/packages/$1/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  clearMocks: true,
};
