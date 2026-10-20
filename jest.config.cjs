module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts', '<rootDir>/tests/contract/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          isolatedModules: true,
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
