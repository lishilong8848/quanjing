const base = require('./jest.admin-configuration.config.cjs');
module.exports = { ...base, moduleNameMapper: { ...base.moduleNameMapper, '^@/(.*)$': '<rootDir>/client/src/$1' } };
