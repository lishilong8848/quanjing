const base = require('./jest.feishu-login.config.cjs');
module.exports = { ...base,
  moduleNameMapper: { ...base.moduleNameMapper, '^@/(.*)$': '<rootDir>/client/src/$1' },
  testMatch: ['<rootDir>/test/unit/ali-monthly-report-email-settings-client.spec.ts', '<rootDir>/test/unit/ali-monthly-report-email-settings-ui.spec.ts', '<rootDir>/test/unit/ali-monthly-report-email-settings-page.spec.ts'],
};
