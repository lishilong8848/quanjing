const base = require('./jest.feishu-login.config.cjs');
const path = require('node:path');
const os = require('node:os');
module.exports = {
  ...base,
  roots: ['<rootDir>/test/unit'],
  testMatch: ['<rootDir>/test/unit/alarm-review-access-runtime.spec.ts'],
  setupFiles: ['<rootDir>/test/support/alarm-review-runtime-network.cjs'],
  reporters: ['<rootDir>/test/support/alarm-review-runtime-reporter.cjs'],
  cache: false,
  cacheDirectory: process.env.ALARM_REVIEW_RUNTIME_CACHE || path.join(os.tmpdir(), 'alarm-review-runtime-tool-unallocated'),
  testTimeout: 15000,
};
