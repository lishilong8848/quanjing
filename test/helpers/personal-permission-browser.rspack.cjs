const path = require('node:path');
const base = require('./professional-browser.rspack.cjs');
module.exports = { ...base, entry: { main: path.join(__dirname, 'personal-permission-browser-entry.tsx') }, output: { ...base.output, path: path.join(process.env.TEMP, 'nt-personal-permission-client-validation') }, devServer: { ...base.devServer, port: 43223, proxy: [{ context: ['/api', '/qa', '/__innerapi__'], target: 'http://127.0.0.1:43224' }] } };
