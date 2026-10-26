'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { root, origin, port, aliases, compilerOptions } = require('./server.cjs');
const evidence = path.join(root, 'output/release-next-after-20261005-182903');
const preparedPath = path.join(evidence, 'alarm-review-real-entry-prepared-20261006-v4.json');
const resultPath = path.join(evidence, 'alarm-review-real-entry-result-20261006-v4.json');
const plan = 'docs/engineering/alarm-review-real-entry-v4-plan-2026-10-06.md';
const original = path.join(root, 'test/visual/alarm-review-real-entry');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');
function safeFile(file) { const actual = path.resolve(file); assert(!fs.lstatSync(actual).isSymbolicLink(), 'REPARSE_INPUT_REJECTED'); return actual; }
function bind(file) { file = safeFile(file); return { file: relative(file), sha256: hash(file) }; }
function checkBinding(input) { assert.equal(hash(path.resolve(root, input.file)), input.sha256, `INPUT_DRIFT:${input.file}`); }

function diagnosticCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) && !/SECRET|TOKEN|PASSWORD|COOKIE/.test(error.code) ? error.code : 'NO_SAFE_ERROR_CODE';
}
function diagnosticSummary(error) {
  const seen = new Set(), nodes = []; let current = error;
  for (let i = 0; current && i < 5 && !seen.has(current); i++) {
    seen.add(current); nodes.push(current); current = typeof current === 'object' ? current.cause || current.error : null;
  }
  const node = [...nodes].reverse().find(value => value?.name === 'CssSyntaxError') || nodes.at(-1) || {};
  const message = typeof node === 'string' ? node : String(node.reason || node.message || '');
  let reason = 'UNKNOWN_REASON_NOT_EXPOSED', reasonGap = true;
  if (/Failed to find ['"]@\/inspector\.dev\.css['"]/.test(message)) { reason = "Failed to find '@/inspector.dev.css'"; reasonGap = false; }
  else if (/Cannot find module/.test(message)) { reason = 'Cannot find module (identifier omitted)'; reasonGap = false; }
  else if (/Module not found/.test(message)) { reason = 'Module not found (identifier omitted)'; reasonGap = false; }
  const rawPath = String(error?.moduleName || '').split('!').at(-1).split('?')[0].replace(/\\/g, '/').replace(/^\.\//, '');
  const modulePath = /^(client|server|shared|test|node_modules)\/[A-Za-z0-9_@./-]+$/.test(rawPath) && !/(secret|token|password|cookie)/i.test(rawPath) && !rawPath.split('/').includes('..') ? rawPath.slice(0, 240) : '<unavailable-or-private>';
  const name = ['CssSyntaxError', 'Error', 'TypeError', 'ModuleBuildError', 'ModuleNotFoundError'].includes(node.name) ? node.name : 'UnknownError';
  const position = key => Number.isSafeInteger(node[key]) && node[key] > 0 ? node[key] : undefined;
  return { path: modulePath, name, code: diagnosticCode(node), reason: reason.slice(0, 400), reasonGap, line: position('line'), column: position('column'), causeDepth: nodes.length, causeTraversalTruncated: Boolean(current && nodes.length === 5) };
}
function checkDiagnosticsContract() {
  const began = Date.now();
  const nested = { moduleName: './client/src/index.css', cause: { name: 'CssSyntaxError', reason: "Failed to find '@/inspector.dev.css'", line: 1, column: 1, source: 'SECRET_CSS_SOURCE', input: { css: 'SECRET_CSS_SOURCE' } } };
  const legacy = value => ({ code: diagnosticCode(value), path: value.moduleName });
  assert.throws(() => assert.equal(legacy(nested).reason, "Failed to find '@/inspector.dev.css'"), { name: 'AssertionError' }, 'LEGACY_MISSING_REASON_NOT_DETECTED');
  const positive = diagnosticSummary(nested);
  assert.equal(positive.reason, "Failed to find '@/inspector.dev.css'"); assert.equal(positive.path, 'client/src/index.css'); assert.equal(positive.reasonGap, false); assert.equal(positive.line, 1);
  for (const value of ['secret=PRIVATE_SECRET', 'token=PRIVATE_TOKEN', 'password=PRIVATE_PASSWORD', 'Cookie: PRIVATE_COOKIE', 'https://private.example/path?token=PRIVATE_TOKEN', 'C:\\Users\\private\\credentials', '/private/credentials', '.private-css{content:"PRIVATE_CSS"}']) {
    const text = JSON.stringify(diagnosticSummary({ moduleName: value, name: 'Error', message: value, stack: value, source: value }));
    assert(!text.includes(value), 'PRIVATE_DIAGNOSTIC_LEAK'); assert.equal(JSON.parse(text).reasonGap, true);
  }
  assert.equal(diagnosticSummary({ name: 'Error', message: 'Module not found: PRIVATE_PASSWORD https://private.example' }).reason, 'Module not found (identifier omitted)');
  assert.equal(diagnosticSummary({ code: 'SECRET_TOKEN' }).code, 'NO_SAFE_ERROR_CODE');
  const cycle = { message: 'unknown' }; cycle.cause = cycle; assert.equal(diagnosticSummary(cycle).causeDepth, 1);
  const capped = Array.from({ length: 12 }, () => nested);
  assert.equal(capped.slice(0, 8).map(diagnosticSummary).length, 8);
  process.stdout.write(JSON.stringify({ status: 'diagnostics-contract-passed', legacyMissingReasonRejected: true, sensitiveCases: 8, cssExecuted: false, compiled: false, serviceStarted: false, browserStarted: false, elapsedMs: Date.now() - began }) + '\n');
}

function prepare() {
  const began = Date.now(), files = new Set(), ts = require('typescript');
  const previous = JSON.parse(fs.readFileSync(path.join(evidence, 'alarm-review-access-runtime-20261006-prepared-v4.json'), 'utf8'));
  for (const item of previous.inputs) { checkBinding(item); files.add(path.resolve(root, item.file)); }
  const add = file => files.add(safeFile(path.resolve(root, file)));
  const priorStartup = path.join(evidence, 'alarm-review-startup-diagnostic-prepared-20261006-v3.json');
  assert.equal(hash(priorStartup), 'c4e8e945a10eac6c6df3e7a64ac1ac009bbdfeabb1a7e033a89a46b5576e23b5');
  const startupInputs = JSON.parse(fs.readFileSync(priorStartup, 'utf8')).inputs; startupInputs.forEach(checkBinding); startupInputs.forEach(item => add(path.resolve(root, item.file))); add(priorStartup);
  add(path.join(evidence, 'alarm-review-startup-diagnostic-result-20261006-v3.json'));
  add(path.join(evidence, 'alarm-review-real-entry-prepared-20261006.json'));
  const browserArgument = process.argv.find(value => value.startsWith('--browser-executable='));
  assert(browserArgument, 'EXPLICIT_EXISTING_BROWSER_REQUIRED');
  const executablePath = safeFile(browserArgument.slice('--browser-executable='.length));
  assert(path.isAbsolute(executablePath) && path.basename(executablePath) === 'chrome.exe', 'BROWSER_PATH_INVALID');
  const systemEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const versionRead = require('node:child_process').spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${executablePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { windowsHide: true, encoding: 'utf8', timeout: 5000, env: systemEnvironment });
  assert.equal(versionRead.status, 0, 'BROWSER_METADATA_READ_FAILED');
  const browserVersion = versionRead.stdout.trim(); assert(/^\d+\.\d+\.\d+\.\d+$/.test(browserVersion), 'BROWSER_VERSION_INVALID');
  add(executablePath);
  for (const file of ['entry.tsx', 'data.ts', 'platform-boundaries.tsx', 'server.cjs', 'verify.cjs']) add(path.join(original, file));
  for (const file of ['server.cjs', 'verify.cjs']) add(path.join(__dirname, file));
  const cssPreparedPath = path.join(evidence, 'alarm-review-css-diagnostic-prepared-20261006-v3.json');
  assert.equal(hash(cssPreparedPath), '661a8a3d1565b656c737651648b652be8d512062061a02a9f8beefab85dfae7a');
  const cssPrepared = JSON.parse(fs.readFileSync(cssPreparedPath, 'utf8'));
  assert.equal(hash(process.execPath), cssPrepared.node.sha256, 'ACTUAL_NODE_DRIFT');
  assert.equal(process.version, cssPrepared.node.version, 'ACTUAL_NODE_VERSION_DRIFT');
  cssPrepared.inputs.forEach(checkBinding);
  cssPrepared.inputs.forEach(item => add(path.resolve(root, item.file)));
  const history = [
    ['output/release-next-after-20261005-182903/alarm-review-real-entry-prepared-20261006-v2.json', 'a50afa2254c1748c71d337205a689550fdbbd7063724b4974e8e132a5f1ac8dc'],
    ['output/release-next-after-20261005-182903/alarm-review-real-entry-result-20261006.json', '291547a1253b4c3fcea1520d246fb998b8c4809a01386d3a903072ed8c6d30b5'],
    ['output/release-next-after-20261005-182903/alarm-review-css-diagnostic-result-20261006-v3.json', '208bad340571933a438206e2cbfdf68b7b986e782327fdd6aad9c21fcb2db0c0'],
    ['output/release-next-after-20261005-182903/workspace-dependency-cache-probe-20261006.json', '5f341091a1b6a408f7ad34519e688855458d91c876a112ca6b231e8f1146a8b9'],
    ['node_modules/@lark-apaas/fullstack-rspack-preset/lib/preset.js', '709d396b94308abba5f9e80f4d95e0ac79e635b925f7203bd58a7923f9e88882'],
  ];
  for (const [file, expected] of history) { assert.equal(hash(path.join(root, file)), expected, 'HISTORY_BINDING_DRIFT'); add(file); }
  add(cssPreparedPath);
  add(path.join(evidence, 'alarm-review-real-entry-v4-preparation-diff-20261006.txt'));
  add(plan);
  const contrast = ['client/src/index.tsx', 'client/src/app-entry.tsx', 'client/src/app.tsx',
    'node_modules/@lark-apaas/client-toolkit/lib/components/AppContainer/index.js',
    'node_modules/@lark-apaas/client-toolkit/lib/components/ErrorRender/index.js',
    'node_modules/@lark-apaas/client-toolkit/lib/utils/getAxiosForBackend.js',
    'node_modules/@lark-apaas/client-toolkit/lib/utils/axiosConfig.js'];
  contrast.forEach(add);
  const tools = ['typescript', '@rspack/core', '@rspack/binding', 'postcss-loader', 'postcss', '@tailwindcss/postcss', '@tailwindcss/node', '@tailwindcss/oxide', 'ts-node', 'tsconfig-paths', 'playwright-core'];
  const toolEntries = tools.map(name => { const entry = require.resolve(name); add(entry); let directory = path.dirname(entry); while (!fs.existsSync(path.join(directory, 'package.json'))) { const parent = path.dirname(directory); assert(parent !== directory, 'PACKAGE_MANIFEST_MISSING'); directory = parent; } add(path.join(directory, 'package.json')); return { name, entry: relative(entry) }; });
  for (const name of ['@rspack/binding', '@tailwindcss/oxide']) {
    let directory = path.dirname(require.resolve(name)); while (!fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory);
    const packageData = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const optional of Object.keys(packageData.optionalDependencies || {}).filter(value => value.includes(`${process.platform}-${process.arch}`))) { const native = require.resolve(optional); add(native); toolEntries.push({ name: optional, entry: relative(native) }); }
  }
  for (const file of ['tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.js', 'package.json', 'package-lock.json']) add(file);
  // Static import closure for project code + local SDK axios imports; no compilation.
  const seen = new Set(), queue = [path.join(original, 'entry.tsx'), path.join(original, 'data.ts'), ...contrast.map(file => path.resolve(root, file))];
  const resolveLocal = (specifier, parent) => {
    let candidate = specifier.startsWith('@/') ? path.join(root, 'client/src', specifier.slice(2)) : specifier.startsWith('@shared/') ? path.join(root, 'shared', specifier.slice(8)) : specifier.startsWith('.') ? path.resolve(path.dirname(parent), specifier) : null;
    if (!candidate) return null;
    return [candidate, ...['.ts', '.tsx', '.js', '.css', '.json'].map(ext => candidate + ext), ...['index.ts', 'index.tsx', 'index.js'].map(name => path.join(candidate, name))].find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
  };
  while (queue.length) {
    const file = queue.pop(); if (seen.has(file)) continue; seen.add(file); add(file);
    if (!/\.[cm]?[jt]sx?$|\.css$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const specs = /\.css$/.test(file) ? [...source.matchAll(/@(?:import|config|source)\s+["']([^"']+)["']/g)].map(match => match[1]) : ts.preProcessFile(source, true, true).importedFiles.map(item => item.fileName);
    for (const specifier of specs) { const next = resolveLocal(specifier, file); if (next && !next.includes(path.sep + 'node_modules' + path.sep)) queue.push(next); else if (next) add(next); }
  }
  const syntax = [];
  for (const name of ['entry.tsx', 'data.ts', 'platform-boundaries.tsx']) { const file = path.join(original, name); const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true); assert.equal(source.parseDiagnostics.length, 0, `SYNTAX:${name}`); syntax.push(name); }
  for (const name of ['server.cjs', 'verify.cjs']) { new (require('node:vm').Script)(fs.readFileSync(path.join(__dirname, name), 'utf8'), { filename: name }); syntax.push(name); }
  const freezes = [JSON.parse(fs.readFileSync(path.join(root, 'docs/engineering/alarm-review-custom-freeze-2026-10-05.json'), 'utf8')).directFiles,
    JSON.parse(fs.readFileSync(path.join(root, 'output/admin-configuration-check/source-freeze.json'), 'utf8')).frozenInputs];
  let frozenCount = 0; for (const inputs of freezes) for (const item of inputs) { checkBinding({ file: item.file || item.path, sha256: item.sha256 }); frozenCount++; }
  const inputs = [...files].sort().map(bind); const digest = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { kind: 'real-application-access-and-panorama-components-equivalent-single-route', status: 'prepared-not-compiled-not-run',
    beganAt: new Date(began).toISOString(), completedAt: new Date().toISOString(), elapsedMs: Date.now() - began,
    command: [process.execPath, relative(__filename), '--prepare', browserArgument], runtimeCommand: [process.execPath, relative(__filename), '--run', '--approved-run'], fixtureVersion: 'v4', priorCssInputCount: cssPrepared.inputs.length, historyBindings: history.map(([file]) => bind(path.join(root, file))), node: { version: process.version, path: process.execPath, sha256: hash(process.execPath) },
    inputs, fingerprint: digest, toolEntries, syntax, frozenCount, browser: { executablePath, version: browserVersion, sha256: hash(executablePath), metadataSource: 'Windows PE ProductVersion, read-only; not launched' }, parentEnvironmentAllowlist: ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'NODE_ENV=test'], aliases: Object.entries(aliases).map(([key, value]) => ({ key, value: relative(value) })),
    originalShellBindings: contrast.slice(0, 5).map(file => bind(path.resolve(root, file))),
    priorV4BindingsUnchanged: previous.inputs.length, compiled: false, browserStarted: false, externalCalls: 0,
    dependencyEvidence: { oldMarker: bind(path.join(root, '.deps-ready.json')), authoritativePhysicalTreeProven: false, gap: 'Legacy marker + exact tool entries are not a complete dependency tree proof. Release owner must bind an independent valid proof before execution acceptance. No dependency scan or installation performed.' },
    excluded: ['full app.tsx lazy-route graph', 'SDK AppContainer AuthProvider/safety/inspector/QueryProvider/IframeBridge/useAppInfo/telemetry', 'SDK ErrorRender platform reporting', 'real Feishu schema/writes', 'production performance P95', 'production build/deployment'],
    scenarios: ['PC admin real UI password login + single custom review', 'PC editor real UI password login + batch review', 'PC guest read-only', '390 editor custom reply/person keyboard/geometry', '390 guest read-only', 'PC editor actual accounts revocation + late accepted and people responses'],
  };
  assert(!fs.existsSync(preparedPath), 'PREPARED_EXISTS_NO_OVERWRITE');
  fs.writeFileSync(preparedPath, JSON.stringify(record, null, 2));
  process.stdout.write(JSON.stringify({ status: record.status, file: relative(preparedPath), sha256: hash(preparedPath), fingerprint: digest, inputCount: inputs.length, frozenCount, elapsedMs: record.elapsedMs }) + '\n');
}

const READY_BUDGET_MS = 60000, READY_OBSERVATION_MS = 12000;
function observeServerReady(child, report, options = {}) {
  const now = options.now || Date.now, schedule = options.schedule || setTimeout, cancel = options.cancel || clearTimeout;
  const started = now(); let soft, hard, settled = false, stage = 'early-isolation';
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { if (settled) return; settled = true; cancel(soft); cancel(hard); child.removeListener('message', message); child.removeListener('exit', exit); if (error) reject(error); else resolve(value); };
    const message = value => {
      if (value?.event === 'startup-phase' && ['early-isolation', 'application-imports', 'nest-module-compile', 'nest-http-listen'].includes(value.stage)) stage = value.stage;
      if (value?.event === 'ready') finish(null, value);
      if (value?.event === 'failed') { report({ event: 'server-start-failed', stage, code: diagnosticCode(value) }); finish(new Error('ISOLATED_SERVER_START_FAILED')); }
    };
    const exit = () => finish(new Error('OWNED_SERVER_EXIT_BEFORE_READY'));
    child.on('message', message); child.once('exit', exit);
    soft = schedule(() => { if (!settled) report({ event: 'startup-deadline-observation', elapsedMs: now() - started, stage }); }, options.softMs ?? READY_OBSERVATION_MS);
    hard = schedule(() => finish(new Error('SERVER_READY_TIMEOUT')), options.timeoutMs ?? READY_BUDGET_MS);
  });
}
function queueSafeClose(child, ready) {
  let sent = false;
  const send = () => { if (!sent && child.connected) { sent = true; child.send({ kind: 'close' }); } };
  const message = value => { if (value?.event === 'ready') { child.removeListener('message', message); send(); } };
  if (ready) send(); else child.on('message', message);
  return () => child.removeListener('message', message);
}
function preserveAssets(phases, assets) {
  assert(assets.some(x => x.name === 'app.js') && assets.some(x => x.name === 'app.css'), 'REQUIRED_ASSETS_MISSING');
  assert(assets.every(x => /^[a-f0-9]{64}$/.test(x.sha256)), 'ASSET_HASH_INVALID'); phases.assets = assets;
}
async function checkEntryContract() {
  const began = Date.now(), { EventEmitter } = require('node:events');
  assert.equal(READY_BUDGET_MS, 60000); assert.equal(READY_OBSERVATION_MS, 12000);
  const source = fs.readFileSync(path.join(__dirname, 'server.cjs'), 'utf8');
  assert(source.indexOf("process.env.DISABLE_V8_COMPILE_CACHE = '1'") > source.indexOf('const policy = isolate(directory);'));
  assert(source.indexOf("process.env.DISABLE_V8_COMPILE_CACHE = '1'") < source.indexOf("require('ts-node').register"));
  const old = process.env.DISABLE_V8_COMPILE_CACHE; let cacheWrites = 0;
  const names = ['mkdirSync', 'writeFileSync', 'unlinkSync'], originals = names.map(name => fs[name]);
  try { process.env.DISABLE_V8_COMPILE_CACHE = '1'; for (const name of names) fs[name] = () => { cacheWrites++; throw new Error('PURE_CACHE_WRITE_REJECTED'); }; assert.equal(require('v8-compile-cache-lib').install(), undefined); assert.equal(cacheWrites, 0); }
  finally { names.forEach((name, i) => { fs[name] = originals[i]; }); if (old === undefined) delete process.env.DISABLE_V8_COMPILE_CACHE; else process.env.DISABLE_V8_COMPILE_CACHE = old; }
  const setup = () => { const child = new EventEmitter(), timers = new Map(); let tick = 0; return { child, timers, options: { now: () => tick, schedule: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id) }, fire: ms => { tick = ms; timers.get(ms)(); } }; };
  const x = setup(), observations = [], result = observeServerReady(x.child, e => observations.push(e), x.options);
  x.child.emit('message', { event: 'startup-phase', stage: 'application-imports' }); x.fire(12000);
  assert.equal(observations.length, 1); assert.equal(observations[0].stage, 'application-imports'); assert.equal(x.timers.has(60000), true);
  const payload = { event: 'ready', policy: { writesRejected: 0 } }; x.child.emit('message', payload); assert.equal(await result, payload); assert.equal(x.timers.size, 0);
  const timeout = setup(), timeoutResult = observeServerReady(timeout.child, () => {}, timeout.options); timeout.fire(60000); await assert.rejects(timeoutResult, /SERVER_READY_TIMEOUT/);
  const dead = setup(), deadResult = observeServerReady(dead.child, () => {}, dead.options); dead.child.emit('exit', 0); await assert.rejects(deadResult, /OWNED_SERVER_EXIT_BEFORE_READY/);
  const bad = setup(), badResult = observeServerReady(bad.child, () => {}, bad.options); bad.child.emit('message', { event: 'failed' }); await assert.rejects(badResult, /ISOLATED_SERVER_START_FAILED/);
  const closing = new EventEmitter(), sends = []; closing.connected = true; closing.send = msg => sends.push(msg);
  const release = queueSafeClose(closing, false); assert.equal(sends.length, 0); closing.emit('message', { event: 'startup-phase' }); assert.equal(sends.length, 0); closing.emit('message', payload); closing.emit('message', payload); assert.deepEqual(sends, [{ kind: 'close' }]); release();
  const phases = {}, assets = [{ name: 'app.js', sha256: 'a'.repeat(64) }, { name: 'app.css', sha256: 'b'.repeat(64) }];
  preserveAssets(phases, assets); assert.deepEqual(JSON.parse(JSON.stringify({ outcome: 'failed', phases })).phases.assets, assets); assert.throws(() => preserveAssets({}, []), /REQUIRED_ASSETS_MISSING/);
  const proof = { status: 'entry-v4-pure-contract-passed', prepared: bind(preparedPath), tool: bind(__filename), node: bind(process.execPath), elapsedMs: Date.now() - began, cacheDisabledWithoutWrites: true, twelveSecondObservationOnly: true, sixtySecondTimeoutRejected: true, earlyExitRejected: true, injectionFailureRejected: true, lateReadyCloseOnce: true, assetsPreservedOnFailure: true, cssExecuted: false, compiled: false, applicationStarted: false, browserStarted: false };
  const file = path.join(evidence, 'alarm-review-real-entry-contract-20261006-v4.json'); assert(!fs.existsSync(file), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(file, JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ status: proof.status, elapsedMs: proof.elapsedMs, sha256: hash(file) }));
}

async function waitFor(test, message, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(message); }
async function browserCases(browser, control, artifact, observations, partialProof) {
  const requests = [], violations = [], errors = [];
  Object.assign(partialProof, { requests, violations, errors });
  let expectRevocationRejection = false;
  const customReply = '合成复核结论：已经核查，待现场确认。';
  function assertTask(task, batch) {
    assert.deepEqual(task.items.map(item => item.recordId).sort(), batch ? ['recSyntheticAlarmA', 'recSyntheticAlarmB', 'recSyntheticAlarmC'] : ['recSyntheticAlarmA'], 'TASK_RECORD_SET_MISMATCH');
    assert.equal(task.outcome, '自定义回复'); assert.equal(task.customReply, customReply, 'TASK_CUSTOM_REPLY_MISMATCH');
    assert.equal(task.responsibleRecordId, 'recSyntheticPersonA', 'TASK_PERSON_ID_MISMATCH');
    assert(task.items.every(item => item.state === 'success'), 'TASK_NOT_SUCCESS');
  }
  async function context(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await ctx.route('**/*', async route => { const url = new URL(route.request().url());
      if (url.origin === origin && !url.username && !url.password || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      violations.push({ kind: 'browser-network-rejected', protocol: url.protocol, host: url.hostname, port: url.port }); await route.abort('blockedbyclient');
    });
    await ctx.addInitScript(() => { document.documentElement.classList.add('light'); });
    ctx.on('page', page => {
      page.on('pageerror', () => errors.push('pageerror'));
      page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status(), expectedAuthorizationRejection: expectRevocationRejection && url.pathname === '/api/bitable/alarm-human-reviews/people' && response.request().method() === 'GET' && [401, 403].includes(response.status()) }); });
    });
    const page = await ctx.newPage(); await page.goto(origin + '/today-operations-panorama');
    return { ctx, page };
  }
  const role = page => page.evaluate(() => window.__alarmEntryObservation?.role);
  async function login(page, wanted) {
    await page.getByRole('button', { name: /当前身份：.*打开身份切换菜单/ }).first().click();
    await page.getByRole('menuitem', { name: '输入密码切换身份' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '统一权限登录' }) });
    await dialog.getByLabel('访问密码').fill(`synthetic-entry-${wanted}-123`);
    await dialog.getByRole('button', { name: '登录', exact: true }).click();
    await waitFor(async () => await role(page) === wanted, 'REAL_LOGIN_NOT_COMMITTED');
  }
  async function openList(page) {
    await page.getByRole('button', { name: /异常打标/ }).first().click();
    await page.getByRole('list', { name: '异常打标告警清单' }).waitFor();
  }
  const form = page => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^异常跟进/ }) });
  async function choose(page, batch = false) {
    if (batch) { await page.getByLabel('选择当前页异常').check(); await page.getByRole('button', { name: '批量跟进', exact: true }).click(); }
    else await page.getByRole('button', { name: '异常跟进', exact: true }).first().click();
    const dialog = form(page); await dialog.getByText('自定义回复', { exact: true }).click();
    await dialog.getByLabel('回复内容').fill('合成复核结论：已经核查，待现场确认。');
    const search = dialog.getByRole('combobox', { name: '搜索示例人员019' }); await search.fill('李 明');
    await dialog.getByRole('option', { name: /合成李明/ }).first().waitFor();
    await search.press('ArrowDown'); await search.press('Enter');
    await waitFor(async () => await dialog.locator('.alarm-review-person-selected').count() === 1, 'PERSON_STABLE_SELECTION_MISSING');
    return dialog;
  }
  async function geometry(page, dialog) {
    const boxes = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect(), close = element.querySelector('[aria-label="关闭异常跟进"]')?.getBoundingClientRect();
      const submit = [...element.querySelectorAll('button')].find(button => button.textContent.includes('提交复核'))?.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1, close: close && { top: close.top, bottom: close.bottom }, submit: submit && { top: submit.top, bottom: submit.bottom }, height: innerHeight };
    });
    assert(boxes.left >= 0 && boxes.right <= boxes.width + 1 && !boxes.overflow, 'DIALOG_HORIZONTAL_OVERFLOW');
    assert(boxes.close && boxes.close.top >= 0 && boxes.close.bottom <= boxes.height, 'CLOSE_CLIPPED');
    assert(boxes.submit && boxes.submit.top >= 0 && boxes.submit.bottom <= boxes.height, 'SUBMIT_CLIPPED');
    await page.screenshot({ path: artifact(`geometry-${observations.length}.png`) }); return boxes;
  }
  for (const scenario of [ { name: 'pc-admin-single', width: 1440, identity: 'admin' }, { name: 'pc-editor-batch', width: 1440, identity: 'editor', batch: true }, { name: 'pc-guest', width: 1440 }, { name: '390-editor', width: 390, identity: 'editor' }, { name: '390-guest', width: 390 } ]) {
    const { ctx, page } = await context(scenario.width);
    try {
      const before = await control({ kind: 'state' });
      if (scenario.identity) await login(page, scenario.identity);
      await openList(page);
      if (!scenario.identity) {
        assert.equal(await page.getByRole('button', { name: '异常跟进', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '批量跟进', exact: true }).count(), 0); assert.equal(await page.getByLabel('选择当前页异常').count(), 0);
        const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length, 'GUEST_CREATED_TASK'); await page.screenshot({ path: artifact(`${scenario.name}.png`) });
      } else {
        const dialog = await choose(page, scenario.batch); const boxes = await geometry(page, dialog);
        const accepted = page.waitForResponse(response => response.url() === origin + '/api/bitable/alarm-human-reviews' && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: '提交复核', exact: true }).click(); assert.equal((await accepted).status(), 201);
        await dialog.getByText(/复核已保存/).waitFor({ timeout: 15000 });
        const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length + 1, 'TASK_COUNT_MISMATCH');
        const task = after.tasks.at(-1); assertTask(task, scenario.batch);
        observations.push({ scenario: scenario.name, result: 'passed', boxes, taskCount: after.tasks.length });
      }
      if (!scenario.identity) observations.push({ scenario: scenario.name, result: 'passed' });
    } finally { await ctx.close(); }
  }
  const editor = await context(1440), admin = await context(1440);
  try {
    await login(editor.page, 'editor'); await login(admin.page, 'admin'); await openList(editor.page);
    await control({ kind: 'gate', name: 'accepted', hold: true });
    const dialog = await choose(editor.page); const before = await control({ kind: 'state' });
    const lateAccepted = editor.page.waitForResponse(response => response.url() === origin + '/api/bitable/alarm-human-reviews' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '提交复核', exact: true }).click();
    await waitFor(async () => (await control({ kind: 'state' })).tasks.length === before.tasks.length + 1, 'ACCEPTED_NOT_DURABLE');
    await control({ kind: 'gate', name: 'people', hold: true });
    const latePeople = editor.page.evaluate(() => window.__alarmEntryObservation.readReviewPeople());
    await waitFor(async () => (await control({ kind: 'state' })).counts['GET /api/bitable/alarm-human-reviews/people'] > (before.counts['GET /api/bitable/alarm-human-reviews/people'] || 0), 'LATE_PEOPLE_NOT_STARTED');
    const disabled = await admin.page.evaluate(async () => {
      const snapshot = await (await fetch('/api/access/configuration', { credentials: 'same-origin' })).json();
      const response = await fetch('/api/access/configuration/accounts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMutationId: 'entry-revoke-editor-00000001', expectedRevision: snapshot.revision, id: 'local-editor-all', kind: 'local', name: '合成子管理员', role: 'editor', building: null, enabled: false }) });
      return response.status;
    });
    assert.equal(disabled, 201, 'REAL_ACCOUNTS_REVOKE_FAILED');
    expectRevocationRejection = true;
    const rejected = editor.page.waitForResponse(response => response.url().endsWith('/alarm-human-reviews/people') && [401, 403].includes(response.status()));
    const fresh = editor.page.evaluate(() => window.__alarmEntryObservation.readReviewPeople()); await rejected; assert.equal(await fresh, false);
    expectRevocationRejection = false;
    await waitFor(async () => await role(editor.page) === 'guest', 'REAL_INVALIDATION_NOT_COMMITTED');
    await waitFor(async () => await form(editor.page).count() === 0, 'REVOKED_FORM_STILL_OPEN');
    await control({ kind: 'gate', name: 'people', hold: false }); await latePeople;
    await control({ kind: 'gate', name: 'accepted', hold: false });
    assert.equal((await lateAccepted).status(), 201, 'LATE_ACCEPTED_NOT_DELIVERED');
    await editor.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await waitFor(async () => !(await editor.page.evaluate(() => sessionStorage.getItem('alarm-human-review-pending-request') || sessionStorage.getItem('alarm-human-review-active-task'))), 'REVOKED_PERSISTENT_STATE_RESURRECTED');
    assert.equal(await role(editor.page), 'guest'); assert.equal(await form(editor.page).count(), 0);
    assert.equal(await editor.page.getByRole('button', { name: '异常跟进', exact: true }).count(), 0); assert.equal(await editor.page.getByLabel('选择当前页异常').count(), 0);
    const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length + 1, 'REVOKED_DUPLICATE_WRITE');
    await waitFor(async () => (await control({ kind: 'state' })).tasks.at(-1).items.every(item => item.state === 'success'), 'REVOKED_ACCEPTED_WORKER_NOT_SUCCESS');
    assertTask((await control({ kind: 'state' })).tasks.at(-1), false);
    await editor.page.screenshot({ path: artifact('revoked.png') }); observations.push({ scenario: 'pc-revocation-late-response', result: 'passed', acceptedBeforeRevocation: true, actualGuardRejected: true });
  } finally { await control({ kind: 'gate', name: 'people', hold: false }); await control({ kind: 'gate', name: 'accepted', hold: false }); await editor.ctx.close(); await admin.ctx.close(); }
  assert.equal(violations.length, 0, 'BROWSER_NETWORK_VIOLATION'); assert.equal(errors.length, 0, 'BROWSER_PAGE_ERROR');
  assert(!requests.some(item => item.status >= 400 && !item.expectedAuthorizationRejection), 'UNEXPECTED_API_FAILURE');
  assert.equal(requests.filter(item => item.expectedAuthorizationRejection).length, 1, 'EXPECTED_GUARD_REJECTION_COUNT');
  return { requests, violations, errors };
}
async function run() {
  assert(process.argv.includes('--approved-run'), 'SEPARATE_RUNTIME_APPROVAL_REQUIRED');
  const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8')); prepared.inputs.forEach(checkBinding);
  assert.equal(hash(process.execPath), prepared.node.sha256, 'NODE_DRIFT');
  assert(!fs.existsSync(resultPath), 'RESULT_EXISTS_NO_OVERWRITE');
  const os = require('node:os'), net = require('node:net');
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-review-entry-')); assert(!/[^\x20-\x7e]/.test(directory));
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ scope: 'alarm-review-real-entry', pid: process.pid, directory: fs.realpathSync(directory) }));
  fs.mkdirSync(path.join(directory, 'bundle')); const output = path.join(directory, 'bundle');
  process.env = { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory, NODE_ENV: 'test' };
  const parentPolicy = { rejectedNetwork: 0, rejectedWrites: 0 };
  const rejectNetwork = () => { parentPolicy.rejectedNetwork++; throw new Error('PARENT_NETWORK_REJECTED'); };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args, target = values[0];
    if (!target || typeof target !== 'object' || target.path || target.host !== '127.0.0.1' || Number(target.port) !== port) rejectNetwork();
    return connect.apply(this, args);
  };
  require('node:tls').connect = rejectNetwork;
  const dns = require('node:dns');
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    const original = dns[name]; if (typeof original === 'function') dns[name] = function (host, ...args) { if (name !== 'lookup' || host !== '127.0.0.1') rejectNetwork(); return original.call(this, host, ...args); };
    if (typeof dns.promises[name] === 'function') dns.promises[name] = async () => rejectNetwork();
    for (const Resolver of [dns.Resolver, dns.promises.Resolver]) if (typeof Resolver?.prototype[name] === 'function') Resolver.prototype[name] = rejectNetwork;
  }
  require('node:dgram').createSocket = rejectNetwork;
  function parentWrite(file) {
    const target = path.resolve(typeof file === 'string' ? file : require('node:url').fileURLToPath(file));
    const within = path.relative(directory, target);
    if (within === '' || !path.isAbsolute(within) && within !== '..' && !within.startsWith('..' + path.sep)) {
      for (let cursor = target; cursor !== path.dirname(directory); cursor = path.dirname(cursor)) if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('PARENT_REPARSE_REJECTED');
      return;
    }
    if (target === evidence || path.dirname(target) === evidence && /^alarm-review-real-entry-[A-Za-z0-9_.-]+\.(json|png)$/.test(path.basename(target))) return;
    parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_REJECTED');
  }
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'createWriteStream', 'mkdtempSync']) { const original = fs[name]; fs[name] = function (file, ...args) { parentWrite(file); return original.call(this, file, ...args); }; }
  const nativeOpen = fs.openSync; fs.openSync = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return nativeOpen.call(this, file, flags, ...args); };
  for (const module of [fs, fs.promises]) for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'truncate', 'chmod', 'mkdtemp']) { const original = module[name]; module[name] = function (file, ...args) { parentWrite(file); return original.call(this, file, ...args); }; }
  for (const module of [fs, fs.promises]) { const rename = module.rename; module.rename = function (from, to, ...args) { parentWrite(from); parentWrite(to); return rename.call(this, from, to, ...args); }; const rm = module.rm; module.rm = function (file, options, ...args) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rm.call(this, file, options, ...args); }; }
  const renameSync = fs.renameSync; fs.renameSync = function (from, to) { parentWrite(from); parentWrite(to); return renameSync.call(this, from, to); };
  const rmSync = fs.rmSync; fs.rmSync = function (file, options) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rmSync.call(this, file, options); };
  for (const module of [fs, fs.promises]) { const open = module.open; module.open = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return open.call(this, file, flags, ...args); }; }
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (typeof fs[name] === 'function') fs[name] = () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (typeof fs.promises[name] === 'function') fs.promises[name] = async () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  const began = Date.now(), observations = [], artifacts = [], phases = {}, diagnostics = []; let child, browser, serverReady = false, outcome = 'failed', errorCode, state, closureModules, compileStartedAt, stage = 'component-compile';
  const safeCode = diagnosticCode;
  const cleanupState = { ownedDirectory: directory, ownerPid: process.pid, childPid: null, ownedDirectoryRemoved: false, childClosed: false, portRebound: false, retainedDirectory: undefined };
  function artifact(name) { const file = path.join(evidence, 'alarm-review-real-entry-v4-' + name); assert(!fs.existsSync(file), 'ARTIFACT_EXISTS'); artifacts.push(file); return file; }
  try {
    const compileStart = compileStartedAt = Date.now(), { rspack } = require('@rspack/core');
    const compiler = rspack(compilerOptions(output));
    try { const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => {
      if (error || stats?.hasErrors()) {
        const report = stats?.toJson({ all: false, errors: true })?.errors || [];
        diagnostics.push({ stage, code: safeCode(error), errorCount: report.length, modules: report.slice(0, 8).map(diagnosticSummary), fatal: error ? diagnosticSummary(error) : undefined });
        reject(new Error('COMPONENT_COMPILE_FAILED'));
      } else resolve(stats);
    })); closureModules = stats.toJson({ all: false, modules: true, nestedModules: true }).modules; }
    finally { try { await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve())); } finally { phases.compileMs = Date.now() - compileStart; } }
    prepared.inputs.forEach(checkBinding);
    const assets = fs.readdirSync(output).map(name => ({ name, sha256: hash(path.join(output, name)) })); assert(assets.some(item => item.name === 'app.css') && assets.some(item => item.name === 'app.js'));
    preserveAssets(phases, assets);
    stage = 'isolated-server-start'; const cp = require('node:child_process'), pending = new Map(); let seq = 0;
    child = cp.fork(path.join(__dirname, 'server.cjs'), [directory], { execPath: process.execPath, cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    cleanupState.childPid = child.pid; const serverStartedAt = Date.now();
    child.on('message', value => { if (value?.event === 'ready') serverReady = true; if (value?.id && pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); } });
    const ready = observeServerReady(child, event => diagnostics.push({ stage, ...event }));
    await ready; phases.serverStartMs = Date.now() - serverStartedAt;
    const control = message => new Promise((resolve, reject) => { const id = String(++seq); const timer = setTimeout(() => { pending.delete(id); reject(new Error('CONTROL_TIMEOUT')); }, 5000); pending.set(id, { resolve, timer }); child.send({ ...message, id }); });
    const { chromium } = require('playwright-core');
    stage = 'browser-launch'; assert.equal(hash(prepared.browser.executablePath), prepared.browser.sha256, 'BROWSER_BINARY_DRIFT');
    browser = await chromium.launch({ executablePath: prepared.browser.executablePath, headless: true, env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory } });
    assert.equal(browser.version(), prepared.browser.version, 'BROWSER_VERSION_DRIFT');
    phases.browserRuntime = { version: browser.version(), executableSha256: prepared.browser.sha256 };
    stage = 'browser-six-scenarios';
    const browserStart = Date.now(); phases.browserProof = {};
    try { await browserCases(browser, control, artifact, observations, phases.browserProof); } finally { phases.browserMs = Date.now() - browserStart; }
    state = await control({ kind: 'state' }); assert.equal(state.policy.networkRejected, 0); assert.equal(state.policy.writesRejected, 0); assert.equal(state.gateTimeouts, 0); assert.equal(parentPolicy.rejectedNetwork, 0); assert.equal(parentPolicy.rejectedWrites, 0); assert.equal(observations.length, 6);
    outcome = 'passed';
  } catch (error) { errorCode = /^[A-Z0-9_:\-/\.]{1,160}$/.test(error.message) ? error.message : 'FIXTURE_EXECUTION_FAILED'; diagnostics.push({ stage, code: safeCode(error), errorCode }); }
  finally {
    if (compileStartedAt && phases.compileMs === undefined) phases.compileMs = Date.now() - compileStartedAt;
    let cleanupFailed = false;
    async function cleanStep(name, action) { try { await action(); } catch (error) { cleanupFailed = true; outcome = 'failed'; errorCode = errorCode || 'FIXTURE_CLEANUP_FAILED'; diagnostics.push({ stage: name, code: safeCode(error) }); } }
    await cleanStep('browser-close', async () => { if (browser) await browser.close(); });
    await cleanStep('owned-server-close', async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const releaseClose = queueSafeClose(child, serverReady);
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('OWNED_SERVER_CLEANUP_TIMEOUT_NO_FORCE_KILL')), 12000); child.once('exit', () => { clearTimeout(timer); releaseClose(); resolve(); }); });
      }
      cleanupState.childClosed = !child || child.exitCode !== null || child.signalCode !== null;
    });
    await cleanStep('source-after-run', async () => { const currentDrift = prepared.inputs.filter(item => hash(path.resolve(root, item.file)) !== item.sha256); if (currentDrift.length) { outcome = 'failed'; errorCode = 'INPUT_DRIFT_AFTER_RUN'; } });
    // Empty directory removal only; never recursive rm or deletion outside the freshly owned marker.
    function cleanup(folder) { assert(!fs.lstatSync(folder).isSymbolicLink()); for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); assert(!fs.lstatSync(file).isSymbolicLink()); if (entry.isDirectory()) { if (folder === directory) { assert(entry.name === 'bundle' || entry.name === 'jiti' || entry.name.startsWith('playwright_'), 'UNKNOWN_ROOT_DIRECTORY_RETAINED'); if (entry.name === 'jiti') assert.equal(fs.readdirSync(file).length, 0, 'NONEMPTY_JITI_RETAINED'); } cleanup(file); } else { if (folder === directory) assert(/^(owner|configuration|ledger)\.json$/.test(entry.name) || entry.name.startsWith('playwright_'), 'UNKNOWN_ROOT_FILE_NO_DELETE'); fs.unlinkSync(file); } } fs.rmdirSync(folder); }
    if (!cleanupFailed) await cleanStep('owned-directory-cleanup', async () => { const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); assert.equal(marker.scope, 'alarm-review-real-entry'); assert.equal(marker.pid, process.pid); assert.equal(marker.directory, fs.realpathSync(directory)); cleanup(directory); });
    cleanupState.ownedDirectoryRemoved = !fs.existsSync(directory); if (!cleanupState.ownedDirectoryRemoved) cleanupState.retainedDirectory = directory;
    await cleanStep('port-rebound', async () => { await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); }); cleanupState.portRebound = true; });
    const result = { kind: prepared.kind, outcome, errorCode, preparedSha256: hash(preparedPath), fingerprint: prepared.fingerprint, node: prepared.node, browser: prepared.browser, phases, diagnostics, observations, state, parentPolicy, compilerModules: closureModules, artifacts: artifacts.filter(file => fs.existsSync(file)).map(bind), childPid: child?.pid, cleanup: cleanupState, elapsedMs: Date.now() - began, dependencyProofGap: prepared.dependencyEvidence.gap, productionAppShellCovered: false, externalSchemaCovered: false };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ outcome, errorCode, result: relative(resultPath), sha256: hash(resultPath), elapsedMs: result.elapsedMs }) + '\n');
    if (outcome !== 'passed') process.exitCode = 1;
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--check-entry-contract')) checkEntryContract().catch(error => { console.error(diagnosticCode(error)); process.exitCode = 1; });
else if (process.argv.includes('--check-diagnostics-contract')) checkDiagnosticsContract();
else if (process.argv.includes('--run')) run().catch(() => { process.stderr.write('FIXTURE_PRECONDITION_OR_CLEANUP_FAILED\n'); process.exitCode = 1; });
else throw new Error('EXPLICIT_PREPARE_OR_APPROVED_RUN_REQUIRED');
