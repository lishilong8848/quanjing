'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/admin-configuration-check/render-isolation-manual-fixed-20261007/assets');
const original = path.join(__dirname, 'admin-configuration-dev-server.cjs');
let source = fs.readFileSync(original, 'utf8');
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('MANUAL_SERVER_SOURCE_CONTRACT_DRIFT');
  source = source.replace(from, to);
}
replaceOnce("const output = path.join(root, `output/admin-configuration-check/${performanceMode ? 'browser-production' : 'browser'}`);", `const output = ${JSON.stringify(output)};`);
replaceOnce("entry: path.join(fixture, 'entry.tsx')", "entry: path.join(fixture, 'manual-entry.tsx')");
if (process.argv.includes('--compile-only')) {
  const finish = 'compiler.close(() => start().catch(error => { console.error(error.message); process.exitCode=1; }))';
  if (source.split(finish).length !== 3) throw new Error('MANUAL_COMPILE_BOUNDARY_DRIFT');
  source = source.split(finish).join("compiler.close(() => console.log('MANUAL_BUNDLE_READY_NO_SERVER'))");
}
const loaded = new Module(original, module);
loaded.filename = original; loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(source, original);
