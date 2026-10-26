const base = require('./jest.feishu-login.config.cjs');
module.exports = {
  ...base,
  testMatch: ['**/*.spec.ts', '**/*.spec.tsx'],
  moduleNameMapper: { ...base.moduleNameMapper, '^@/(.*)$': '<rootDir>/client/src/$1' },
};
