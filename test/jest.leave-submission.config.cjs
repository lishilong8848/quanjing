const base = require('./jest.self-service.config.cjs');
module.exports = {
  ...base,
  roots: [...base.roots, '<rootDir>/server/modules/leave-workflow'],
};
