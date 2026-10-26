const path = require('node:path');
const base = require('./meeting-browser.rspack.cjs');
module.exports = {
  ...base,
  entry: { main: path.join(__dirname, 'self-service-browser-entry.tsx') },
  output: { ...base.output, path: path.join(process.env.TEMP, 'nt-self-service-client-validation') },
  watchOptions: { ignored: ['**/output/**', '**/docs/**', '**/.git/**', '**/test/**/self-service-browser-fixture.cjs'] },
  devServer: {
    ...base.devServer, port: 43235,
    devMiddleware: { writeToDisk: true },
    proxy: [{ context: ['/api', '/qa', '/__innerapi__'], target: 'http://127.0.0.1:43236' }],
  },
};
