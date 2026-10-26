const base = require('./jest.feishu-login.config.cjs');
module.exports = { ...base, roots: ['<rootDir>/server/common/access', '<rootDir>/test/unit', '<rootDir>/server/modules/inventory-outbound-approval', '<rootDir>/server/modules/purchase-inventory', '<rootDir>/server/modules/contract-management'] };
