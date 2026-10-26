const base = require('./jest.feishu-guest.config.cjs');
module.exports = { ...base, roots: ['<rootDir>/server', '<rootDir>/test/unit'], transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: false, module: 'commonjs', target: 'ES2022', jsx: 'react-jsx' } }] } };
