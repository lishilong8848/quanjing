module.exports = { ...require('./personal-permission-jest.cjs'), moduleNameMapper: { ...require('../../package.json').jest.moduleNameMapper, '^@/(.*)$': '<rootDir>/client/src/$1' } };
