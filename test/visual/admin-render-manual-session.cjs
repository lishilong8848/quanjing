'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'output/admin-configuration-check/render-isolation-manual-fixed-20261007');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = path.join(__dirname, 'admin-configuration-foreground-perf.cjs');
function helperSource() {
  let source = fs.readFileSync(original, 'utf8');
  const replaceOnce = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('MANUAL_HELPER_SOURCE_CONTRACT_DRIFT');
    source = source.replace(from, to);
  };
  replaceOnce("require('./admin-configuration-foreground-preload.cjs')", "require('./admin-render-manual-preload.cjs')");
  replaceOnce("return ['--require', path.join(__dirname, 'admin-configuration-foreground-preload.cjs'), path.join(__dirname, 'admin-configuration-dev-server.cjs')", "return ['--require', path.join(__dirname, 'admin-render-manual-preload.cjs'), path.join(__dirname, 'admin-render-manual-server.cjs')");
  replaceOnce("const prepared = JSON.parse(fs.readFileSync(path.join(out, 'foreground-performance-loopback-prepared.json'), 'utf8'))", `const prepared = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, 'prepared.json'))}, 'utf8'))`);
  replaceOnce('complete && controls.length === 20 &&', 'complete &&');
  replaceOnce('closes.slice(1).map', 'closes.slice(1, 21).map');
  replaceOnce('closes.length === 21 &&', 'closes.length >= 21 &&');
  replaceOnce('dialogs.length === 21 ? percentile(dialogs.slice(1).map', 'dialogs.length >= 21 ? percentile(dialogs.slice(1, 21).map');
  replaceOnce('completeNativeCoverage: complete, controlCount:', 'completeNativeCoverage: complete, capturedCloseCount: closes.length, surplusCloseCount: Math.max(0, closes.length - 21), fixedPrefixSelection: true, controlCount:');
  replaceOnce("status: 'single-run-observed-not-release-approval'", "status: 'manual-native-20-groups-no-control-not-release-approval'");
  return source;
}
function prepare() {
  const assetDirectory = path.join(directory, 'assets');
  const compile = JSON.parse(fs.readFileSync(path.join(assetDirectory, 'production-fixture-compile-evidence.json'), 'utf8'));
  const binding = file => ({ path: file, sha256: sha(file) });
  const inputs = compile.inputs.map(item => ({ path: path.join(root, item.path), sha256: item.sha256 }));
  for (const file of [__filename, original, path.join(__dirname, 'admin-configuration-foreground-preload.cjs'), path.join(__dirname, 'admin-render-manual-preload.cjs'), path.join(__dirname, 'admin-render-manual-server.cjs'), path.join(root, 'test/fixtures/admin-configuration-browser/manual-entry.tsx')]) {
    if (!inputs.some(item => item.path === file)) inputs.push(binding(file));
  }
  for (const item of inputs) if (sha(item.path) !== item.sha256) throw new Error('MANUAL_COMPILE_INPUT_DRIFT');
  const assets = ['app.js', 'app.css'].map(name => binding(path.join(assetDirectory, name)));
  if (assets[0].sha256 !== compile.appSha256 || assets[1].sha256 !== compile.cssSha256) throw new Error('MANUAL_ASSET_DRIFT');
  const prepared = { status: 'manual-only-prepared-no-browser-input', inputs, assetDirectory, assets,
    node: binding(process.execPath), chrome: binding('C:/Users/36056/AppData/Local/Google/Chrome/Application/chrome.exe'),
    protocol: 'Human clicks only: one warmup then first twenty edit/close groups by sequence, never selected by duration. No control subtraction, automatic input or CUA tools. Collection automatically serializes after the final group; surplus retained and counted. Missing native Event Timing coverage remains unknown, not zero. Retain all data/directories.',
    derivedHelperSha256: crypto.createHash('sha256').update(helperSource()).digest('hex') };
  const target = path.join(directory, 'prepared.json');
  fs.writeFileSync(target, JSON.stringify(prepared, null, 2), { flag: 'wx' });
  return { target, sha256: sha(target), inputs: inputs.length, assets };
}
function load() {
  const loaded = new Module(original, module);
  loaded.filename = original; loaded.paths = Module._nodeModulePaths(path.dirname(original));
  const source = helperSource();
  const prepared = JSON.parse(fs.readFileSync(path.join(directory, 'prepared.json'), 'utf8'));
  if (crypto.createHash('sha256').update(source).digest('hex') !== prepared.derivedHelperSha256) throw new Error('MANUAL_HELPER_DRIFT');
  loaded._compile(source, original);
  return loaded.exports;
}
module.exports = { prepare, load, helperSource };
if (require.main === module && process.argv.includes('--prepare')) console.log(JSON.stringify(prepare()));
