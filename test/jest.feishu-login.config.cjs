const path = require('node:path');
const base = require('../package.json').jest;
module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '..'),
  roots: ['<rootDir>/server/common/access', '<rootDir>/test/unit'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          isolatedModules: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          module: 'commonjs',
          target: 'ES2022',
          jsx: 'react-jsx',
        },
      },
    ],
  },
};
