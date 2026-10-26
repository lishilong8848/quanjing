const path = require('node:path');
const base = require('./meeting-browser.rspack.cjs');
module.exports = { ...base, entry: { main: path.join(__dirname, 'additional-self-service-browser-entry.tsx') },
  output: { ...base.output, path: path.join(process.env.TEMP, 'nt-additional-self-service-client-validation') },
  devServer: { ...base.devServer, port: 43245, devMiddleware: { writeToDisk: true },
    proxy: [{ context: ['/api', '/qa', '/__innerapi__'], target: 'http://127.0.0.1:43246' }] } };
