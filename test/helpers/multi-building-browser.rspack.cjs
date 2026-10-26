const path = require('node:path');
const base = require('./professional-browser.rspack.cjs');
module.exports = { ...base, entry: { main: path.join(__dirname, 'multi-building-browser-entry.tsx') }, output: { ...base.output, path: path.join(process.env.TEMP, 'nt-multi-building-client-validation') } };
