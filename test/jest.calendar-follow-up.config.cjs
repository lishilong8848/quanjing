const base = require('./jest.monthly-operations.config.cjs');
module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/test/unit/calendar-*.spec.ts',
    '<rootDir>/test/unit/exception-follow-up*.spec.ts',
    '<rootDir>/test/unit/monthly-schedule-calendar-compact.spec.ts',
  ],
};
