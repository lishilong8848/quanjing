const path = require('node:path');
const base = require('./login-entry-browser.rspack.cjs');
module.exports = {
  ...base,
  output: { ...base.output, path: path.join(process.env.TEMP, 'nt-leave-applicant-client-validation') },
  devServer: {
    ...base.devServer,
    port: 43225,
    proxy: [{ context: ['/api', '/qa', '/__innerapi__'], target: 'http://127.0.0.1:43226' }],
  },
};
