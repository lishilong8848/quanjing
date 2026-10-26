const path = require('node:path');
module.exports = { ...require('../../package.json').jest, rootDir: path.resolve(__dirname, '../..'), transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] } };
