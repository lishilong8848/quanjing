module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  roots: ['<rootDir>/server', '<rootDir>/test'],
  modulePathIgnorePatterns: ['<rootDir>/output/', '<rootDir>/release/'],
  moduleNameMapper: {
    '^@server/(.*)$': '<rootDir>/server/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
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
