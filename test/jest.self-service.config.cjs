const base = require('./jest.feishu-login.config.cjs');
module.exports = { ...base, roots: [...base.roots, '<rootDir>/server/modules/bitable-sync'] };
