'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'output/admin-configuration-check');
const boundary = require('./admin-configuration-foreground-preload.cjs');
const chrome = 'C:/Users/36056/AppData/Local/Google/Chrome/Application/chrome.exe';
const chromeSha = 'c7440b91930ea50dd35b8ea0638ef7af40b4c544c3deab828fa34414fc7b5502';
const node = path.join(root, 'output/runtime-tools/node-v24.15.0-win-x64/node.exe');
const nodeSha = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const binding = file => ({ path: file, sha256: sha(file) });
function environment(directory, source = process.env) {
  return { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => typeof source[key] === 'string').map(key => [key, source[key]])), TEMP: directory, TMP: directory, DISABLE_V8_COMPILE_CACHE: '1', ADMIN_PERF_OWNER_DIRECTORY: directory };
}
function argumentsFor(directory) {
  return ['--require', path.join(__dirname, 'admin-configuration-foreground-preload.cjs'), path.join(__dirname, 'admin-configuration-dev-server.cjs'), path.join(directory, 'configuration.json'), '--performance', '--large', '--reuse-client'];
}
function requireRun(argv) { if (!argv.includes('--run') || !argv.includes('--approved-single-run')) throw new Error('PERF_RUN_NOT_APPROVED'); }
function ownerDirectory(scope) {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vnet-admin-foreground-'));
  assert(!/[^\x20-\x7e]/.test(directory)); assert.equal(fs.realpathSync(directory), directory);
  const marker = { scope: 'admin-foreground-performance', phase: scope, parentPid: process.pid, directory, publicAssets: ['vnet-logo.png', 'vnet-logo-transparent.png'].map(name => { const file = path.join(root, 'client/public/assets', name); return { file, sha256: sha(file) }; }) };
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(marker)); return { directory, marker };
}
function closeContractDirectory(directory) {
  const names = fs.readdirSync(directory); assert(names.every(name => ['owner.json', 'configuration.json'].includes(name)), 'CONTRACT_UNKNOWN_RETAIN');
  for (const name of names) { const file = path.join(directory, name); assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); const proof = binding(file); assert.equal(sha(file), proof.sha256); fs.unlinkSync(file); }
  fs.rmdirSync(directory);
}
async function installedContract(mode = 'full') {
  const owner = ownerDirectory(mode === 'dns' ? 'dns-contract' : 'pure-contract');
  const env = environment(owner.directory); delete env.ADMIN_PERF_OWNER_DIRECTORY; env.ADMIN_PERF_CONTRACT_DIRECTORY = owner.directory;
  const child = require('node:child_process').spawn(node, [__filename, mode === 'dns' ? '--dns-contract-child' : '--guard-contract-child'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let result, diagnostic = '';
  child.on('message', value => { if (value?.event === (mode === 'dns' ? 'dns-contract' : 'installed-contract')) result = value; });
  child.stderr.on('data', value => { diagnostic += String(value).slice(0, 500); });
  const exit = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(exit, 0, 'INSTALLED_CONTRACT_FAILED:' + diagnostic.slice(0, 300)); assert(result?.passed, 'CONTRACT_RESULT_MISSING');
  closeContractDirectory(owner.directory); return result;
}
async function contractChild() {
  const directory = process.env.ADMIN_PERF_CONTRACT_DIRECTORY;
  const Module = require('node:module'), original = Module._load; let executed = 0;
  Module._load = function (request, ...args) { return request === '@rspack/core' ? { rspack: () => ({ run: () => { executed++; } }) } : original.call(this, request, ...args); };
  const policy = boundary.install(directory);
  fs.writeFileSync(path.join(directory, 'configuration.json'), '{"synthetic":true}');
  assert.throws(() => fs.writeFileSync(path.join(directory, 'unowned.txt'), 'synthetic'), /WRITESREJECTED/);
  assert.throws(() => fs.readFileSync(path.join(directory, '.env')), /READSREJECTED/);
  const promise = fs.promises.writeFile(path.join(directory, 'configuration.json'), 'synthetic'); assert(promise instanceof Promise); await assert.rejects(promise, /WRITESREJECTED/);
  assert.throws(() => new (require('node:net').Socket)().connect(443, 'example.invalid'), /NETWORKREJECTED/);
  assert.throws(() => require('@rspack/core').rspack({}).run(), /COMPILERRUNREJECTED/); assert.equal(executed, 0);
  const before = fs.statSync(boundary.output).mtimeMs; fs.mkdirSync(boundary.output, { recursive: true }); assert.equal(fs.statSync(boundary.output).mtimeMs, before);
  await new Promise((resolve, reject) => fs.open(path.join(boundary.output, 'app.js'), 'r', (error, fd) => { if (error) reject(error); else fs.close(fd, closeError => closeError ? reject(closeError) : resolve()); }));
  assert.equal(policy.networkRejected, 1); assert.equal(policy.writesRejected, 2); assert.equal(policy.readsRejected, 1); assert.equal(policy.compilerRunRejected, 1);
  process.send({ event: 'installed-contract', passed: true, networkAttempted: false, realCompilerLoaded: false, policy });
}
async function dnsContractChild() {
  const policy = boundary.install(process.env.ADMIN_PERF_CONTRACT_DIRECTORY), dns = require('node:dns');
  const addresses = await new Promise((resolve, reject) => dns.lookup.call(dns, '127.0.0.1', { all: true }, (error, values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }]);
  for (const address of ['localhost', '127.0.0.2', 'example.invalid']) assert.throws(() => dns.lookup(address, () => {}), /NETWORKREJECTED/);
  assert.throws(() => dns.resolve4('127.0.0.1', () => {}), /NETWORKREJECTED/);
  assert.equal(policy.networkRejected, 4); assert.equal(policy.writesRejected, 0);
  process.send({ event: 'dns-contract', passed: true, nativeLiteralLookup: addresses, noPortBound: true, noApplicationLoaded: true, policy });
}
async function prepareLoopback() {
  const began = Date.now(), priorPath = path.join(out, 'foreground-performance-runtime-prepared.json');
  assert.equal(sha(priorPath), 'b44ea686f9bf38594077dda7c27a22d70bfe97cac91b28dda37b95d90fc5e2aa', 'PRIOR_PREPARED_DRIFT');
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
  const changed = new Set([__filename, path.join(__dirname, 'admin-configuration-foreground-preload.cjs'), path.join(root, 'docs/engineering/admin-configuration-foreground-performance-plan-2026-10-06.md')]);
  for (const item of [...prior.inputs, ...prior.assets, prior.node, prior.chrome]) if (!changed.has(item.path)) assert.equal(sha(item.path), item.sha256, 'UNRELATED_INPUT_DRIFT');
  const literalDnsContract = await installedContract('dns');
  const record = { ...prior, status: 'prepared-loopback-fix-not-executed', priorPrepared: binding(priorPath), inputs: prior.inputs.map(item => binding(item.path)), reusedContracts: 'Original helper/install results retained; not rerun or claimed byte-identical. Only literal DNS branch and IPC stop changed.', literalDnsContract, elapsedMs: Date.now() - began };
  const target = path.join(out, 'foreground-performance-loopback-prepared.json'); assert(!fs.existsSync(target), 'LOOPBACK_PREPARED_EXISTS'); fs.writeFileSync(target, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, elapsedMs: record.elapsedMs, evidence: target, sha256: sha(target) }));
}
async function contracts() {
  const passed = [], check = (name, action) => { action(); passed.push(name); };
  check('assets-existing-identity-and-SHA', () => assert.equal(boundary.assetProof().size, 2));
  check('missing-assets-refuse-instead-of-build', () => assert.throws(() => boundary.assetProof(path.join(out, 'nonexistent-perf-assets')), /ENOENT/));
  check('only-exact-loopback', () => { boundary.loopback('127.0.0.1', 43212); for (const [host, port] of [['localhost', 43212], ['127.0.0.1', 39894], ['example.invalid', 43212]]) assert.throws(() => boundary.loopback(host, port), /NETWORK_REJECTED/); });
  check('config-only-write-boundary', () => { const base = path.join(require('node:os').tmpdir(), 'admin-perf-contract-only'); boundary.ownedFile(path.join(base, 'configuration.json.lock'), base); assert.throws(() => boundary.ownedFile(path.join(base, 'app.js'), base), /WRITE_REJECTED/); assert.throws(() => boundary.ownedFile(path.join(base, 'configuration.json:stream'), base), /WRITE_REJECTED/); });
  let rejects = 0; const guardedPromise = boundary.promiseReject(() => { rejects++; throw new Error('WRITE_REJECTED'); });
  await assert.rejects(guardedPromise(), /WRITE_REJECTED/); assert.equal(rejects, 1); passed.push('Promise-rejection-not-sync-false-success');
  check('actual-child-arguments-mandatory-reuse', () => { const args = argumentsFor('C:/synthetic-only'); assert(args.includes('--reuse-client')); assert(args.includes('--performance')); assert(args.includes('--large')); assert(args.includes('--require')); });
  check('allowlist-does-not-forward-secret-env', () => assert.deepEqual(Object.keys(environment('C:/synthetic-only', { SystemRoot: 'synthetic', FEISHU_APP_SECRET: 'synthetic-only', UNKNOWN: 'synthetic-only' })).sort(), ['ADMIN_PERF_OWNER_DIRECTORY', 'DISABLE_V8_COMPILE_CACHE', 'SystemRoot', 'TEMP', 'TMP'].sort()));
  check('run-is-explicitly-gated', () => { assert.throws(() => requireRun(['--run']), /RUN_NOT_APPROVED/); requireRun(['--run', '--approved-single-run']); });
  return passed;
}
async function prepare() {
  const began = Date.now(); assert.equal(sha(chrome), chromeSha, 'CHROME_BINARY_DRIFT');
  assert.equal(sha(node), nodeSha, 'NODE_BINARY_DRIFT');
  const passed = await contracts(); const installed = await installedContract();
  const files = [__filename, path.join(__dirname, 'admin-configuration-foreground-preload.cjs'), path.join(__dirname, 'admin-configuration-dev-server.cjs'), path.join(__dirname, 'alarm-review-overlay-fix-v1/server.cjs'), path.join(root, 'docs/engineering/admin-configuration-foreground-performance-plan-2026-10-06.md'), path.join(root, 'test/fixtures/admin-configuration-browser/performance.ts'), path.join(root, 'test/fixtures/admin-configuration-browser/entry.tsx'), path.join(root, 'test/fixtures/admin-configuration-browser/styles.css'), require.resolve('playwright-core')];
  for (const file of ['node_modules/playwright-core/package.json', 'node_modules/playwright-core/lib/client/browserType.js', 'node_modules/playwright-core/lib/server/utils/processLauncher.js', 'package.json', 'package-lock.json']) files.push(path.join(root, file));
  const record = { status: 'prepared-runtime-path-not-executed', supersedes: 'foreground-performance-prepared.json is pure helper contracts only, not runnable evidence', node: binding(node), chrome: { ...binding(chrome), version: '119.0.6045.106' }, inputs: files.map(binding), assets: boundary.assets.map(([name]) => binding(path.join(boundary.output, name))), publicAssets: ['vnet-logo.png', 'vnet-logo-transparent.png'].map(name => ({ file: path.join(root, 'client/public/assets', name), sha256: sha(path.join(root, 'client/public/assets', name)) })), contracts: passed, installedContract: installed, childArguments: argumentsFor('<new-absolute-ASCII-owned-directory>'), browser: { method: 'launchPersistentContext', headless: false, profile: 'new isolated owned directory', extraFlags: [] }, sampling: { warmup: 1, fixedGroups: 20, sequence: 'control -> edit same synthetic account -> native mouse close', preserveAll: true, subtractControl: false, requiredNativeEvents: ['pointerdown', 'pointerup', 'click'], closeP95UpperMs: 100, dialogP95Ms: 150 }, activation: 'sky list_windows before/after; unique returned new window; activate; observe -> one action -> refresh; prove visible/focused before sampling', cleanup: 'Only owned context/server; exact identity cleanup or retain. No deletion framework.', elapsedMs: Date.now() - began };
  const target = path.join(out, 'foreground-performance-runtime-prepared.json');
  if (fs.existsSync(target)) { const previous = JSON.parse(fs.readFileSync(target, 'utf8')); assert.equal(previous.status, 'prepared-runtime-path-not-executed'); const archive = target + '.before-final-static-review.json'; assert(!fs.existsSync(archive)); fs.copyFileSync(target, archive); record.supersededPreparedSha256 = sha(archive); }
  fs.writeFileSync(target, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, contracts: passed.length, elapsedMs: record.elapsedMs, evidence: target, sha256: sha(target) }));
}
async function setup(argv) {
  requireRun(argv); const prepared = JSON.parse(fs.readFileSync(path.join(out, 'foreground-performance-loopback-prepared.json'), 'utf8'));
  for (const item of [...prepared.inputs, ...prepared.assets, prepared.node, prepared.chrome]) assert.equal(sha(item.path), item.sha256, 'RUNTIME_INPUT_DRIFT');
  const owner = ownerDirectory('single-runtime'), policy = [], requests = [], rejectedRequests = [];
  const run = { directory: owner.directory, owner: owner.marker, child: null, context: null, page: null, policy, requests, rejectedRequests, startedAt: Date.now(), phase: 'server-start', setupError: null, serverExit: null, diagnostics: [] };
  try {
    const child = require('node:child_process').spawn(node, argumentsFor(owner.directory), { cwd: root, env: environment(owner.directory), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); run.child = child;
    child.on('message', message => { if (message?.event === 'perf-policy') policy.push(message.policy); });
    child.once('exit', (code, signal) => { run.serverExit = { code, signal }; });
    let stdout = ''; child.stderr.on('data', value => { const match = String(value).match(/\b(?:ERR_[A-Z_]+|PERF_[A-Z_]+|ENOENT|EACCES|EADDRINUSE)\b/); run.diagnostics.push({ phase: run.phase, category: match?.[0] || 'UNCLASSIFIED_STARTUP_STDERR' }); });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('PERF_SERVER_READY_TIMEOUT')), 20000); child.once('exit', () => { clearTimeout(timer); reject(new Error('PERF_SERVER_EARLY_EXIT')); }); child.stdout.on('data', value => { stdout += String(value); if (stdout.includes('ADMIN_CONFIGURATION_FIXTURE_READY')) { clearTimeout(timer); resolve(); } }); });
    run.phase = 'browser-launch';
    const { chromium } = require('playwright-core');
    run.context = await chromium.launchPersistentContext(path.join(owner.directory, 'profile'), { executablePath: chrome, headless: false, viewport: { width: 1280, height: 900 }, env: environment(owner.directory), serviceWorkers: 'block' });
    await run.context.route('**/*', async route => { const request = route.request(), url = new URL(request.url()); const method = request.method();
      if (url.origin === 'http://127.0.0.1:43212' && !url.username && !url.password && ['GET', 'HEAD'].includes(method) || ['data:', 'blob:'].includes(url.protocol)) { requests.push({ method, origin: url.origin, path: url.pathname }); return route.continue(); }
      rejectedRequests.push({ phase: run.phase, method, protocol: url.protocol, host: url.hostname, category: ['GET', 'HEAD'].includes(method) ? 'external-read' : 'write-rejected' }); return route.abort('blockedbyclient');
    });
    run.page = run.context.pages()[0] || await run.context.newPage(); run.phase = 'fixture-load';
    await run.page.goto('http://127.0.0.1:43212/fixture/login'); await run.page.locator('#configuration-performance').waitFor({ state: 'attached' });
    assert(await run.page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('event')), 'PERF_EVENT_TIMING_UNAVAILABLE');
    run.phase = 'awaiting-unique-sky-foreground-binding'; return run;
  } catch (error) { run.setupError = { phase: run.phase, code: /^[A-Z_]+$/.test(error.message || '') ? error.message : 'PERF_SETUP_FAILED' }; await finish(run); throw new Error(run.setupError.code); }
}
async function readiness(run) { return run.page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus(), samples: Number(document.querySelector('#configuration-performance')?.getAttribute('data-count') || 0), editorOpen: Boolean(document.querySelector('.configuration-editor[data-state="open"]')) })); }
function percentile(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null; }
async function finish(run) {
  const cleanup = { browserClosed: false, serverClosed: false, retainedDirectory: run.directory }, errors = [];
  let raw = null, metrics = null;
  try { if (run.page && !run.page.isClosed()) { const value = await run.page.locator('#configuration-performance').getAttribute('data-result'); if (value) raw = JSON.parse(value); } } catch { errors.push('RAW_EXPORT_READ_FAILED'); }
  if (raw) {
    const closes = raw.capturedEvents.filter(event => event.eventName === 'pointerdown' && event.name === '关闭');
    const serials = closes.slice(1).map(event => event.serial);
    const groups = serials.map(serial => raw.eventTimings.filter(event => event.capturedSerial === serial));
    const complete = closes.length === 21 && groups.length === 20 && groups.every(group => ['pointerdown', 'pointerup', 'click'].every(name => group.some(event => event.eventName === name && event.trusted === true)));
    const native = groups.map(group => group.length ? Math.max(...group.map(event => event.duration)) : null);
    const dialogs = raw.samples.filter(sample => sample.category === 'cached-dialog');
    const closeP95UpperMs = complete ? percentile(native) + 4 : null, dialogP95Ms = dialogs.length === 21 ? percentile(dialogs.slice(1).map(sample => sample.elapsedMs)) : null;
    const visible = raw.samples.every(sample => sample.visibility === 'visible' && sample.focused && sample.ready && sample.requests === 0);
    const controls = raw.samples.filter(sample => sample.category === 'control');
    metrics = { completeNativeCoverage: complete, controlCount: controls.length, nativeDurations: native, closeP95UpperMs, dialogP95Ms, allSamplesReadyVisibleFocusedNoExtraReads: visible, performancePassed: complete && controls.length === 20 && closeP95UpperMs <= 100 && dialogP95Ms !== null && dialogP95Ms <= 150 && visible };
  }
  try { if (run.context) { await run.context.close(); cleanup.browserClosed = true; } } catch { errors.push('OWNED_BROWSER_CLOSE_FAILED'); }
  try { if (run.child) { if (!run.serverExit) { run.child.send({ event: 'perf-stop' }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('OWNED_SERVER_CLOSE_TIMEOUT')), 15000); run.child.once('exit', () => { clearTimeout(timer); resolve(); }); }); } cleanup.serverClosed = Boolean(run.serverExit); } } catch { errors.push('OWNED_SERVER_CLOSE_FAILED_NO_FORCE_KILL'); }
  const record = { status: 'single-run-observed-not-release-approval', directory: run.directory, childPid: run.child?.pid, phase: run.phase, setupError: run.setupError, diagnostics: run.diagnostics, raw, metrics, requests: run.requests, rejectedRequests: run.rejectedRequests, nodePolicy: run.policy, cleanup, errors, elapsedMs: Date.now() - run.startedAt };
  const result = path.join(out, 'foreground-performance-run-' + path.basename(run.directory) + '.json'); assert(!fs.existsSync(result)); fs.writeFileSync(result, JSON.stringify(record, null, 2)); return { result, sha256: sha(result), metrics, cleanup, errors };
}
module.exports = { environment, argumentsFor, requireRun, contracts, prepare, prepareLoopback, setup, readiness, finish };
if (require.main === module) {
  if (process.argv.includes('--dns-contract-child')) dnsContractChild().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect(); });
  else if (process.argv.includes('--prepare-loopback')) prepareLoopback().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
  else if (process.argv.includes('--guard-contract-child')) contractChild().catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect(); });
  else if (process.argv.includes('--prepare')) prepare().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
  else { try { requireRun(process.argv); throw new Error('USE_NODE_REPL_SETUP_TO_PRESERVE_SKY_HANDLES'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
