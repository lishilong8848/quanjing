const base = require('./jest.monthly-operations.config.cjs');
module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/test/unit/nantong-portal.spec.ts',
    '<rootDir>/test/unit/nantong-portal-images.spec.ts',
    '<rootDir>/test/unit/portal-static-cache.spec.ts',
    '<rootDir>/server/modules/bitable-sync/nantong-assistant.service.spec.ts',
  ],
};
