const base = require('../package.json').jest;
module.exports = {
  ...base,
  rootDir: require('node:path').resolve(__dirname, '..'),
  roots: ['<rootDir>/test/unit'],
  testMatch: [
    '<rootDir>/test/unit/threshold-management.spec.ts',
    '<rootDir>/test/unit/threshold-matrix.spec.ts',
    '<rootDir>/test/unit/threshold-sync.spec.ts',
    '<rootDir>/test/unit/threshold-adjustments.spec.ts',
    '<rootDir>/test/unit/threshold-adjustment-gateway.spec.ts',
    '<rootDir>/test/unit/threshold-card-router.spec.ts',
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
          isolatedModules: true,
        },
      },
    ],
  },
};
