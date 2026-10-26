const base = require('../package.json').jest;
module.exports = {
  ...base,
  rootDir: require('node:path').resolve(__dirname, '..'),
  testMatch: [
    '<rootDir>/test/integration/monthly-operations-changes-service.spec.ts',
    '<rootDir>/test/integration/monthly-operations-new-sources.spec.ts',
  ],
  modulePathIgnorePatterns: [
    ...base.modulePathIgnorePatterns,
    '<rootDir>/.tmp/',
    '<rootDir>/.tmp-codex/',
  ],
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          module: 'commonjs',
          target: 'ES2022',
        },
      },
    ],
  },
};
