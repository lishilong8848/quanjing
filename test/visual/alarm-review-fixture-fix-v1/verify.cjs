'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { root, origin, port, aliases, compilerOptions } = require('./server.cjs');
const evidence = path.join(root, 'output/release-next-after-20261005-182903');
const preparedPath = path.join(evidence, 'alarm-review-real-entry-fixture-fix-prepared-20261006-v1.json');
const resultPath = path.join(evidence, 'alarm-review-real-entry-fixture-fix-result-20261006-v1.json');
const plan = 'docs/engineering/alarm-review-fixture-fix-v1-plan-2026-10-06.md';
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


const reusedAssets = [
  { file: 'C:/Users/36056/AppData/Local/Temp/alarm-review-entry-YnD5xq/bundle/app.js', name: 'app.js', sha256: '2c4cb13e6956b40ba96bf2fc01cbe9de37dd035e8a17e053419b0c2117aa5391' },
  { file: 'C:/Users/36056/AppData/Local/Temp/alarm-review-entry-YnD5xq/bundle/app.css', name: 'app.css', sha256: '3846897bdc6b79c67d8049c6fd832debe43de4c7f42fc0cfb5f83a9414987bf6' },
];
function assertReusedAsset(item) { safeFile(item.file); assert.equal(hash(item.file), item.sha256, 'REUSED_ASSET_HASH_MISMATCH'); }
function prepare() {
  const started = Date.now(), mono = performance.now();
  const priorPath = path.join(evidence, 'alarm-review-real-entry-cdp-prepared-20261006-v1.json');
  assert.equal(hash(priorPath), '1a12bdc84d35e1b9ace8df411f3c306f5fefcbb6c111768b4e7d45f3398a0050');
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8')); prior.inputs.forEach(checkBinding);
  assert.equal(hash(process.execPath), prior.node.sha256); assert.equal(process.version, prior.node.version); assert.equal(hash(prior.browser.executablePath), prior.browser.sha256);
  const files = new Set(prior.inputs.map(x => path.resolve(root, x.file)));
  for (const file of [__filename, path.join(__dirname, 'server.cjs'), plan, priorPath, path.join(evidence, 'alarm-review-fixture-fix-v1-preparation-diff-20261006.txt'),
    path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json'),
    'node_modules/playwright-core/lib/client/browserContext.js', 'node_modules/playwright-core/lib/client/cdpSession.js',
    'node_modules/playwright-core/lib/client/errors.js', 'node_modules/playwright-core/lib/server/errors.js',
    'node_modules/playwright-core/lib/server/chromium/crProtocolHelper.js', 'node_modules/playwright-core/types/types.d.ts',
    'node_modules/playwright-core/types/protocol.d.ts', path.join(evidence, 'alarm-review-real-entry-pageerror-contract-20261006-v1.json')]) files.add(safeFile(path.resolve(root, file)));
  assert.equal(hash(path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json')), '9b6f30df405eb9b3cf64f98e265033689f7136ca253ee3ec09db3004a9df7836');
  for (const item of reusedAssets) assertReusedAsset(item);
  new (require('node:vm').Script)(fs.readFileSync(__filename, 'utf8'), { filename: __filename });
  const inputs = [...files].sort().map(bind), fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { ...prior, status: 'fixture-fix-prepared-not-run', fixtureVersion: 'fixture-fix-v1', inputs, fingerprint,
    beganAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, monotonicElapsedMs: performance.now() - mono,
    command: [process.execPath, relative(__filename), '--prepare'], runtimeCommand: [process.execPath, relative(__filename), '--run', '--approved-run'],
    compilerWillRun: false, pageCount: 7, loginAllowed: true, submitAllowed: true, scenarios: 6, observationBudgetMs: 1000, gotoTimeoutMs: 10000 };
  assert(!fs.existsSync(preparedPath), 'PREPARED_EXISTS_NO_OVERWRITE'); fs.writeFileSync(preparedPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, sha256: hash(preparedPath), inputs: inputs.length, fingerprint, elapsedMs: record.elapsedMs, monotonicElapsedMs: record.monotonicElapsedMs }));
}

function retainOwned(directory, state) {
  state.ownedDirectoryRemoved = false; state.retainedDirectory = directory; state.retentionReason = 'PROMISE_ONLY_DIAGNOSTIC_NO_DELETION';
  return { outcome: 'failed', errorCode: 'OWNED_DIRECTORY_INTENTIONALLY_RETAINED' };
}
async function checkRetentionContract() {
  const began = Date.now(), oldFile = path.join(root, 'test/visual/alarm-review-browser-only-v1/verify.cjs');
  const oldSource = fs.readFileSync(oldFile, 'utf8'), source = fs.readFileSync(__filename, 'utf8');
  const extract = (text, begin, end) => { const from = text.indexOf('\n' + begin), to = text.indexOf('\n' + end, from); assert(from >= 0 && to > from, 'FUNCTION_BOUNDARY_MISSING'); return text.slice(from, to); };
  for (const [begin, end] of [['function promiseRm(', 'function browserFailureSummary('], ['function browserFailureSummary(', 'async function checkBrowserContract()']]) {
    assert.equal(extract(source, begin, end), extract(oldSource, begin, end), 'V1_PROVEN_LOGIC_CHANGED');
  }
  const previousContract = path.join(evidence, 'alarm-review-real-entry-browser-contract-20261006-v1.json');
  assert.equal(hash(previousContract), '872ec6ca9fd567e2c31c5ca926af9f3ae5b99142e3884096cb18b8473a78e33a');
  const previous = JSON.parse(fs.readFileSync(previousContract, 'utf8')); checkBinding(previous.actualRemoveFolders); checkBinding(previous.tool);
  const retained = {}, verdict = retainOwned('synthetic-owned', retained);
  assert.deepEqual(verdict, { outcome: 'failed', errorCode: 'OWNED_DIRECTORY_INTENTIONALLY_RETAINED' });
  assert.equal(retained.ownedDirectoryRemoved, false); assert.equal(retained.retainedDirectory, 'synthetic-owned');
  const runtimeStart = source.indexOf('\nasync function run()'); assert(runtimeStart >= 0, 'RUN_BOUNDARY_MISSING'); const runtime = source.slice(runtimeStart);
  assert(!runtime.includes('cleanup(directory)')); assert(!runtime.includes('function cleanup(folder)')); assert(!retainOwned.toString().includes('fs.'));
  assert(runtime.includes('const retention = retainOwned(directory, cleanupState); outcome = retention.outcome;'));
  const proof = { status: 'browser-only-retention-contract-passed', prepared: bind(preparedPath), tool: bind(__filename), node: bind(process.execPath), inheritedPure: bind(previousContract),
    originalPureSourceAndRemoveFoldersUnchanged: true, recursiveCleanupAbsent: true, retainedVerdictAlwaysRed: true, noFsDeletionInRetention: true, compiled: false, serviceStarted: false, browserStarted: false, elapsedMs: Date.now() - began };
  const output = path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json');
  assert(!fs.existsSync(output), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(output, JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ status: proof.status, elapsedMs: proof.elapsedMs, sha256: hash(output) }));
}

function promiseRm(native, validate, recursiveRejected) {
  return function (file, options, ...args) {
    try { validate(file); if (options?.recursive) recursiveRejected(); return native.call(this, file, options, ...args); }
    catch (error) { return Promise.reject(error); }
  };
}
function browserFailureSummary(error) {
  const message = String(error?.message || '');
  const categories = [
    ['Target page, context or browser has been closed', 'BROWSER_TARGET_CLOSED'],
    ['Failed to launch', 'BROWSER_LAUNCH_FAILED'], ['executable doesn', 'BROWSER_EXECUTABLE_MISSING'],
    ['ProcessSingleton', 'BROWSER_PROFILE_SINGLETON'], ['Timeout', 'BROWSER_TIMEOUT'],
    ['EPERM', 'BROWSER_PERMISSION_DENIED'], ['EACCES', 'BROWSER_PERMISSION_DENIED'],
    ['RECURSIVE_RM_REJECTED', 'RECURSIVE_RM_REJECTED'],
  ];
  const reason = categories.find(([pattern]) => message.includes(pattern))?.[1] || 'UNKNOWN_BROWSER_REASON_NOT_EXPOSED';
  const exit = /<process did exit: exitCode=(-?\d+|null), signal=(null|SIG[A-Z]+)>/.exec(message);
  const pid = /<launched> pid=(\d+)/.exec(message);
  return { reason, reasonGap: reason === 'UNKNOWN_BROWSER_REASON_NOT_EXPOSED', code: diagnosticCode(error),
    browserPid: pid ? Number(pid[1]) : null, browserExitCode: exit && exit[1] !== 'null' ? Number(exit[1]) : null,
    browserSignal: exit?.[2] || null };
}
async function checkBrowserContract() {
  const began = Date.now(), file = path.join(root, 'node_modules/playwright-core/lib/server/utils/fileUtils.js');
  const { removeFolders } = require(file), native = fs.promises.rm, recursiveError = new Error('RECURSIVE_RM_REJECTED'), externalError = new Error('PARENT_WRITE_REJECTED');
  let rejected = 0, nativeCalls = 0; const normalPromise = Promise.resolve('normal'), target = { rm: () => normalPromise }, args = ['synthetic-owned', { recursive: false }, 'extra'];
  try {
    fs.promises.rm = () => { rejected++; throw recursiveError; };
    await assert.rejects(removeFolders(['synthetic-owned']), error => error === recursiveError);
    assert.equal(rejected, 1);
    fs.promises.rm = promiseRm(() => { nativeCalls++; }, path => { if (path !== 'synthetic-owned') { rejected++; throw externalError; } }, () => { rejected++; throw recursiveError; });
    const recovered = await removeFolders(['synthetic-owned']); assert.equal(recovered.length, 1); assert.equal(recovered[0], recursiveError); assert.equal(rejected, 2); assert.equal(nativeCalls, 0);
    const denied = fs.promises.rm('synthetic-outside', { recursive: true }); assert(denied instanceof Promise); await assert.rejects(denied, error => error === externalError); assert.equal(rejected, 3); assert.equal(nativeCalls, 0);
    const normal = promiseRm(function (...actual) { assert.equal(this, target); assert.deepEqual(actual, args); return normalPromise; }, () => {}, () => { throw recursiveError; });
    assert.equal(normal.apply(target, args), normalPromise); await normalPromise;
  } finally { fs.promises.rm = native; }
  assert.equal(fs.promises.rm, native);
  for (const item of reusedAssets) assertReusedAsset(item);
  assert.throws(() => assertReusedAsset({ ...reusedAssets[0], sha256: '0'.repeat(64) }), /REUSED_ASSET_HASH_MISMATCH/);
  for (const text of ['PRIVATE_SECRET', 'password=PRIVATE_PASSWORD', 'https://private.example/token', 'C:\\Users\\private\\cookie']) assert(!JSON.stringify(browserFailureSummary({ message: text, stack: text })).includes(text));
  assert.equal(browserFailureSummary({ message: 'Target page, context or browser has been closed\n<launched> pid=123\n<process did exit: exitCode=1, signal=null>' }).browserPid, 123);
  const proof = { status: 'browser-only-pure-contract-passed', prepared: bind(preparedPath), tool: bind(__filename), actualRemoveFolders: bind(file), node: bind(process.execPath),
    legacySyncThrowRed: true, sameErrorRecovered: true, deniedPromiseContract: true, unknownWriteCounted: true, nativePromiseThisArgsIdentity: true, methodRestored: true,
    recursiveDeletionStillDenied: true, badAssetHashRejected: true, fixedFailureSummaryPrivateCases: 4, compiled: false, serviceStarted: false, browserStarted: false, elapsedMs: Date.now() - began };
  const output = path.join(evidence, 'alarm-review-real-entry-browser-contract-20261006-v2.json'); assert(!fs.existsSync(output), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(output, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, elapsedMs: proof.elapsedMs, sha256: hash(output) }));
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
async function browserCases(browser, control, artifact, observations, partialProof, checkpoint, stop) {
  const requests = [], violations = [], errors = [], cdpErrors = [], sessions = new Map(), closures = new WeakMap(), bound = bundleModules();
  Object.assign(partialProof, { requests, violations, errors, cdpErrors });
  function closeContext(ctx) {
    if (closures.has(ctx)) return closures.get(ctx);
    const task = (async () => { try { const cdp = sessions.get(ctx); if (cdp) { checkpoint('cdp-detach-start'); await cdp.detach(); checkpoint('cdp-detach-complete'); sessions.delete(ctx); } } finally { await ctx.close(); } })();
    closures.set(ctx, task); return task;
  }
  Object.defineProperty(partialProof, 'closeContexts', { value: async () => { for (const ctx of sessions.keys()) await closeContext(ctx); }, enumerable: false });
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
    ctx.on('page', page => {
      page.on('pageerror', error => { const summary = pageErrorSummary(error, bound); errors.push(summary); checkpoint('pageerror', { error: summary }); stop(new Error('BROWSER_PAGE_ERROR_STOPPED')); });
      page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status(), expectedAuthorizationRejection: expectRevocationRejection && url.pathname === '/api/bitable/alarm-human-reviews/people' && response.request().method() === 'GET' && [401, 403].includes(response.status()) }); });
    });
    const page = await ctx.newPage(); checkpoint('cdp-session-start'); const cdp = await ctx.newCDPSession(page); sessions.set(ctx, cdp);
    cdp.on('Runtime.exceptionThrown', payload => { const summary = cdpExceptionSummary(payload.exceptionDetails, bound); cdpErrors.push(summary); checkpoint('cdp-exception', { error: summary, order: cdpErrors.length }); stop(new Error('BROWSER_CDP_ERROR_STOPPED')); });
    checkpoint('cdp-runtime-enable-start'); await cdp.send('Runtime.enable'); checkpoint('cdp-runtime-enable-complete');
    checkpoint('page-goto-start'); await page.goto(origin + '/today-operations-panorama'); checkpoint('page-goto-complete');
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
    } finally { await closeContext(ctx); }
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
  } finally { await control({ kind: 'gate', name: 'people', hold: false }); await control({ kind: 'gate', name: 'accepted', hold: false }); try { await closeContext(editor.ctx); } finally { await closeContext(admin.ctx); } }
  assert.equal(violations.length, 0, 'BROWSER_NETWORK_VIOLATION'); assert.equal(errors.length, 0, 'BROWSER_PAGE_ERROR');
  assert(!requests.some(item => item.status >= 400 && !item.expectedAuthorizationRejection), 'UNEXPECTED_API_FAILURE');
  assert.equal(requests.filter(item => item.expectedAuthorizationRejection).length, 1, 'EXPECTED_GUARD_REJECTION_COUNT');
  return { requests, violations, errors };
}

function bundleModules() {
  assertReusedAsset(reusedAssets[0]);
  const lines = fs.readFileSync(reusedAssets[0].file, 'utf8').split(/\r?\n/), modules = [];
  lines.forEach((line, i) => {
    const match = /^"(\.\/[^"]+)"\(__unused_rspack_module,/.exec(line);
    if (match && /^\.\/(client|shared|test|node_modules)\/[A-Za-z0-9_@./-]+$/.test(match[1])) modules.push({ id: match[1], line: i + 1 });
  });
  return { lines, modules };
}
function pageErrorSummary(error, bound) {
  const name = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'].includes(error?.name) ? error.name : 'UnknownError';
  const code = ['ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE'].includes(error?.code) ? error.code : 'NO_SAFE_ERROR_CODE';
  const reason = name === 'ReferenceError' && error?.message === 'process is not defined' ? 'PROCESS_NOT_DEFINED' : 'UNKNOWN_PAGE_ERROR';
  const match = /http:\/\/127\.0\.0\.1:39894\/app\.js:(\d+):(\d+)(?=[)\s]|$)/.exec(String(error?.stack || ''));
  let line = null, column = null, moduleId = null;
  if (match) {
    const l = Number(match[1]), c = Number(match[2]);
    if (Number.isSafeInteger(l) && l > 0 && l <= bound.lines.length && Number.isSafeInteger(c) && c > 0 && c <= bound.lines[l - 1].length + 1) {
      line = l; column = c; moduleId = bound.modules.filter(item => item.line <= l).at(-1)?.id || null;
    }
  }
  return { name, code, reason, line, column, moduleId };
}
async function checkPageErrorContract() {
  const started = Date.now(), mono = performance.now(), bound = bundleModules();
  const first = bound.modules[0]; assert(first);
  const positive = pageErrorSummary({ name: 'ReferenceError', message: 'process is not defined', stack: 'ReferenceError: PRIVATE\n at http://127.0.0.1:39894/app.js:' + first.line + ':1' }, bound);
  assert.equal(positive.reason, 'PROCESS_NOT_DEFINED'); assert.equal(positive.moduleId, first.id); assert.equal(positive.column, 1);
  const privateCases = ['SECRET_VALUE', 'password=PRIVATE', 'Cookie: PRIVATE', 'https://private.example/?token=PRIVATE', 'C:\\Users\\private\\credentials', '<html>PRIVATE</html>'];
  for (const privateValue of privateCases) {
    const summary = pageErrorSummary({ name: privateValue, code: privateValue, message: privateValue, stack: privateValue, html: privateValue }, bound);
    assert(!JSON.stringify(summary).includes(privateValue)); assert.equal(summary.name, 'UnknownError'); assert.equal(summary.line, null);
  }
  for (const stack of ['http://private.example/app.js:1:1', origin + '/app.js:999999999:1', origin + '/app.js:1:999999999', origin + '/app.js?token=PRIVATE:1:1']) assert.equal(pageErrorSummary({ stack }, bound).line, null);
  const source = fs.readFileSync(__filename, 'utf8'), old = fs.readFileSync(path.join(root, 'test/visual/alarm-review-browser-only-v3/verify.cjs'), 'utf8');
  const extract = (text, begin, end) => { const from = text.indexOf('\n' + begin), to = text.indexOf('\n' + end, from); assert(from >= 0 && to > from); return text.slice(from, to); };
  for (const [begin, end] of [['function promiseRm(', 'function browserFailureSummary('], ['function retainOwned(', 'async function checkRetentionContract('], ['function observeServerReady(', 'function queueSafeClose(']]) assert.equal(extract(source, begin, end), extract(old, begin, end));
  const runtime = source.slice(source.indexOf('\nasync function run()')); assert(!runtime.includes('await browserCases(')); assert(runtime.includes('await capturePageError('));
  const proof = { status: 'pageerror-pure-contract-passed', tool: bind(__filename), prepared: bind(preparedPath), node: bind(process.execPath),
    inheritedPromise: bind(path.join(evidence, 'alarm-review-real-entry-browser-contract-20261006-v1.json')),
    inheritedRetention: bind(path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json')),
    privateCases: privateCases.length, invalidPositionCases: 4, inheritedFunctionsUnchanged: true, compiled: false, browserStarted: false, serviceStarted: false,
    elapsedMs: Date.now() - started, monotonicElapsedMs: performance.now() - mono };
  const output = path.join(evidence, 'alarm-review-real-entry-pageerror-contract-20261006-v1.json');
  assert(!fs.existsSync(output), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(output, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, sha256: hash(output), elapsedMs: proof.elapsedMs, monotonicElapsedMs: proof.monotonicElapsedMs }));
}

function cdpExceptionSummary(details, bound) {
  const names = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'];
  const name = names.includes(details?.exception?.className) ? details.exception.className : 'UnknownError';
  const frames = Array.isArray(details?.stackTrace?.callFrames) ? details.stackTrace.callFrames : [];
  const candidates = [...frames, ...(details?.url !== undefined ? [details] : [])];
  let sourcePresent = false, droppedFrames = 0, location = null;
  for (const frame of candidates) {
    if (frame?.url !== origin + '/app.js') { droppedFrames++; continue; }
    sourcePresent = true;
    const l = frame.lineNumber, c = frame.columnNumber;
    if (!Number.isSafeInteger(l) || !Number.isSafeInteger(c) || l < 0 || c < 0 || l >= bound.lines.length || c >= bound.lines[l].length + 1) { droppedFrames++; continue; }
    if (!location) {
      const line = l + 1, column = c + 1;
      const index = bound.modules.findIndex((item, i) => item.line <= line && bound.modules[i + 1]?.line > line);
      location = { line, column, moduleId: index >= 0 ? bound.modules[index].id : null };
    }
  }
  return { name, location, sourcePresent, droppedFrames };
}
async function checkCdpContract() {
  const started = Date.now(), mono = performance.now(), bound = bundleModules(), first = bound.modules[0];
  const helperPath = path.join(root, 'node_modules/playwright-core/lib/server/chromium/crProtocolHelper.js');
  const serverErrorsPath = path.join(root, 'node_modules/playwright-core/lib/server/errors.js');
  const clientErrorsPath = path.join(root, 'node_modules/playwright-core/lib/client/errors.js');
  const details = { exception: { className: 'TypeError', description: 'TypeError: SYNTHETIC_PRIVATE' },
    stackTrace: { callFrames: [{ url: origin + '/app.js', lineNumber: first.line - 1, columnNumber: 0, functionName: 'PRIVATE_FN' }] } };
  const legacy = require(clientErrorsPath).parseError(require(serverErrorsPath).serializeError(require(helperPath).exceptionToError(details)));
  assert.equal(legacy.stack, '');
  assert.throws(() => assert.notEqual(pageErrorSummary(legacy, bound).line, null), { name: 'AssertionError' });
  const safe = cdpExceptionSummary(details, bound);
  assert.deepEqual(safe, { name: 'TypeError', location: { line: first.line, column: 1, moduleId: first.id }, sourcePresent: true, droppedFrames: 0 });
  assert(!JSON.stringify(safe).includes('PRIVATE'));
  const fallback = cdpExceptionSummary({ url: origin + '/app.js', lineNumber: 0, columnNumber: 0 }, bound);
  assert.equal(fallback.location.line, 1); assert.equal(fallback.location.column, 1);
  for (const url of ['https://private.example/app.js', origin + '/app.js?token=PRIVATE', origin + '/other.js']) {
    const value = cdpExceptionSummary({ stackTrace: { callFrames: [{ url, lineNumber: 0, columnNumber: 0 }] } }, bound);
    assert.equal(value.location, null); assert.equal(value.sourcePresent, false); assert.equal(value.droppedFrames, 1); assert(!JSON.stringify(value).includes(url));
  }
  for (const [lineNumber, columnNumber] of [[-1, 0], [0, -1], [0.5, 0], [0, 0.5], [Infinity, 0], [bound.lines.length, 0], [0, bound.lines[0].length + 1]]) {
    const value = cdpExceptionSummary({ url: origin + '/app.js', lineNumber, columnNumber }, bound);
    assert.equal(value.location, null); assert.equal(value.sourcePresent, true); assert.equal(value.droppedFrames, 1);
  }
  assert.deepEqual(cdpExceptionSummary({}, bound), { name: 'UnknownError', location: null, sourcePresent: false, droppedFrames: 0 });
  for (const privateValue of ['password=PRIVATE', 'Cookie: PRIVATE', '<html>PRIVATE</html>', 'https://private.example/?token=PRIVATE', 'C:\\private\\credentials']) {
    const value = cdpExceptionSummary({ text: privateValue, message: privateValue, stack: privateValue, html: privateValue, exception: { className: privateValue, description: privateValue } }, bound);
    assert(!JSON.stringify(value).includes(privateValue));
  }
  const source = fs.readFileSync(__filename, 'utf8'), old = fs.readFileSync(path.join(root, 'test/visual/alarm-review-pageerror-v1/verify.cjs'), 'utf8');
  const extract = (text, begin, end) => { const from = text.indexOf('\n' + begin), to = text.indexOf('\n' + end, from); assert(from >= 0 && to > from); return text.slice(from, to); };
  for (const [begin, end] of [['function promiseRm(', 'function browserFailureSummary('], ['function retainOwned(', 'async function checkRetentionContract('], ['function observeServerReady(', 'function queueSafeClose('], ['function pageErrorSummary(', 'async function checkPageErrorContract(']]) assert.equal(extract(source, begin, end), extract(old, begin, end));
  const actual = extract(source, 'async function capturePageError(', 'async function run()');
  assert(actual.indexOf("cdp.on('Runtime.exceptionThrown'") < actual.indexOf('await cdp.send('));
  assert(actual.indexOf("await cdp.send('Runtime.enable')") < actual.indexOf('await page.goto('));
  assert(actual.includes('await cdp.detach()')); assert(!actual.includes('.catch('));
  const proof = { status: 'cdp-pure-contract-passed', prepared: bind(preparedPath), tool: bind(__filename), node: bind(process.execPath),
    serializationSources: [helperPath, serverErrorsPath, clientErrorsPath].map(bind),
    inheritedPromise: bind(path.join(evidence, 'alarm-review-real-entry-browser-contract-20261006-v1.json')),
    inheritedRetention: bind(path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json')),
    syntheticSerializationLocationLostRed: true, structuredPositionRecoveredGreen: true, invalidUrlCases: 3, invalidCoordinateCases: 7,
    privateCases: 5, noFramePreservesNull: true, subscriptionBeforeGoto: true, compiled: false, browserStarted: false, serviceStarted: false,
    elapsedMs: Date.now() - started, monotonicElapsedMs: performance.now() - mono };
  const output = path.join(evidence, 'alarm-review-real-entry-cdp-contract-20261006-v1.json');
  assert(!fs.existsSync(output), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(output, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, sha256: hash(output), elapsedMs: proof.elapsedMs, monotonicElapsedMs: proof.monotonicElapsedMs }));
}

async function capturePageError(browser, checkpoint, observations, partial) {
  const bound = bundleModules(), errors = [], cdpErrors = [], counters = { apiResponses: 0, apiGetResponses: 0, apiWriteResponses: 0, rejectedNetwork: 0 };
  Object.assign(partial, { errors, cdpErrors, counters }); checkpoint('page-context-start');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); let cdp; checkpoint('page-context-complete');
  try {
    await ctx.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && !url.username && !url.password || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      counters.rejectedNetwork++; checkpoint('page-network-rejected', { count: counters.rejectedNetwork }); await route.abort('blockedbyclient');
    });
    checkpoint('page-newPage-start'); const page = await ctx.newPage(); checkpoint('page-newPage-complete');
    page.setDefaultTimeout(3000);
    page.on('pageerror', error => { const summary = pageErrorSummary(error, bound); errors.push(summary); checkpoint('pageerror', { error: summary }); });
    page.on('domcontentloaded', () => checkpoint('page-domcontentloaded'));
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) { counters.apiResponses++; if (response.request().method() === 'GET') counters.apiGetResponses++; else counters.apiWriteResponses++; } });
    checkpoint('cdp-session-start'); cdp = await ctx.newCDPSession(page); checkpoint('cdp-session-complete');
    cdp.on('Runtime.exceptionThrown', payload => {
      const summary = cdpExceptionSummary(payload.exceptionDetails, bound); cdpErrors.push(summary); checkpoint('cdp-exception', { error: summary, order: cdpErrors.length });
    });
    checkpoint('cdp-runtime-enable-start'); await cdp.send('Runtime.enable'); checkpoint('cdp-runtime-enable-complete');
    checkpoint('page-goto-start');
    try { await page.goto(origin + '/today-operations-panorama', { waitUntil: 'domcontentloaded', timeout: 10000 }); checkpoint('page-goto-complete'); }
    catch (error) { partial.gotoFailure = browserFailureSummary(error); checkpoint('page-goto-failed', { failure: partial.gotoFailure }); }
    checkpoint('page-observation-start', { budgetMs: 1000 }); await new Promise(resolve => setTimeout(resolve, 1000)); checkpoint('page-observation-complete');
    checkpoint('page-dom-summary-start');
    const dom = await page.evaluate(() => ({
      rootCount: document.querySelectorAll('#root').length, rootChildren: document.querySelector('#root')?.childElementCount || 0,
      identityButtonCount: [...document.querySelectorAll('button')].filter(item => /^当前身份：.*打开身份切换菜单$/.test(item.getAttribute('aria-label') || '')).length,
      pageLoadFailed: document.body.textContent.includes('页面加载失败'), pageUnavailable: document.body.textContent.includes('当前页面暂时不可用'),
      observationExists: Object.prototype.hasOwnProperty.call(window, '__alarmEntryObservation')
    }));
    Object.assign(partial, { dom }); checkpoint('page-dom-summary-complete', { dom });
    observations.push({ scenario: 'single-page-diagnostic-only', errors: errors.length, cdpErrors: cdpErrors.length, dom, counters });
  } finally {
    try {
      if (cdp) { checkpoint('cdp-detach-start'); await cdp.detach(); checkpoint('cdp-detach-complete'); }
    } finally { checkpoint('page-context-close-start'); await ctx.close(); checkpoint('page-context-close-complete'); }
  }
}


async function checkFixtureFixContract() {
  const started = Date.now(), mono = performance.now();
  const serverPath = path.join(__dirname, 'server.cjs'), oldServerPath = path.join(root, 'test/visual/alarm-review-real-entry-v4/server.cjs');
  const serverSource = fs.readFileSync(serverPath, 'utf8'), oldServer = fs.readFileSync(oldServerPath, 'utf8');
  const source = fs.readFileSync(__filename, 'utf8'), oldSource = fs.readFileSync(path.join(root, 'test/visual/alarm-review-cdp-v1/verify.cjs'), 'utf8');
  const oldInit = /await ctx\.addInitScript\((\(\) => \{ document\.documentElement\.classList\.add\('light'\); \})\);/.exec(oldSource); assert(oldInit);
  assert.throws(() => new (require('node:vm').Script)('(' + oldInit[1] + ')()').runInNewContext({ document: { documentElement: null } }), { name: 'TypeError' });
  assert(!source.includes('await ctx.addInitScript(')); assert(serverSource.includes('<html lang="zh-CN" class="light">'));
  const { verifyBundleReads, bundleReadOpen } = require('./server.cjs');
  const proofs = verifyBundleReads(reusedAssets); let denied = 0, calls = 0;
  const reject = () => { denied++; throw new Error('FIXTURE_WRITE_REJECTED'); }, marker = {}, callback = () => {}, target = {};
  assert.throws(() => reject(reusedAssets[0].file, 'r', callback), /FIXTURE_WRITE_REJECTED/);
  const wrapped = bundleReadOpen(function (...args) { calls++; assert.equal(this, target); assert.deepEqual(args, [reusedAssets[0].file, 'r', 0o666, callback]); return marker; }, proofs, reject);
  assert.equal(wrapped.call(target, reusedAssets[0].file, 'r', 0o666, callback), marker); assert.equal(calls, 1);
  for (const flags of ['w', 'r+', 'wx', 'a', 'rs', 'unknown', 1, 2, NaN, undefined]) assert.throws(() => wrapped.call(target, reusedAssets[0].file, flags, callback), /FIXTURE_WRITE_REJECTED/);
  assert.throws(() => wrapped.call(target, path.join(root, 'package.json'), 'r', callback), /FIXTURE_WRITE_REJECTED/);
  assert.equal(denied, 12); assert.equal(calls, 1);
  assert.throws(() => verifyBundleReads([{ ...reusedAssets[0], sha256: '0'.repeat(64) }]), /BUNDLE_READ_HASH_MISMATCH/);
  const originalOpen = fs.open, bytes = [];
  try {
    fs.open = bundleReadOpen(originalOpen, proofs, reject);
    for (const asset of reusedAssets) {
      let count = 0;
      await new Promise((resolve, rejectStream) => { const stream = fs.createReadStream(asset.file); stream.on('data', chunk => { count += chunk.length; }); stream.once('error', rejectStream); stream.once('end', resolve); });
      assert.equal(count, proofs.get(path.resolve(asset.file)).size); bytes.push({ name: asset.name, bytes: count });
    }
    const numeric = await new Promise((resolve, rejectOpen) => fs.open(reusedAssets[0].file, fs.constants.O_RDONLY, (error, fd) => error ? rejectOpen(error) : resolve(fd)));
    fs.closeSync(numeric);
  } finally { fs.open = originalOpen; }
  assert.equal(fs.open, originalOpen); assert.equal(denied, 12);
  const normalizeServer = text => text.replace(/\n+function verifyBundleReads[\s\S]*?\nfunction isolate\(directory\)/, '\nfunction isolate(directory)')
    .replace("  const readProofs = verifyBundleReads(assetHashes.map(([name, sha256]) => ({ file: path.join(directory, 'bundle', name), sha256 })));\n  const callbackOpen = fs.open;\n", '')
    .replace("'chmod', 'createWriteStream'", "'chmod', 'open', 'createWriteStream'")
    .replace('  fs.open = bundleReadOpen(callbackOpen, readProofs, rejectWrite);\n', '')
    .replace('compilerOptions, serve, verifyBundleReads, bundleReadOpen };', 'compilerOptions, serve };');
  assert.equal(normalizeServer(serverSource).replace(/\r\n/g, '\n'), oldServer.replace(/\r\n/g, '\n'), 'UNRELATED_SERVER_GUARD_CHANGED');
  const extract = (text, begin, end) => { const from = text.indexOf('\n' + begin), to = text.indexOf('\n' + end, from); assert(from >= 0 && to > from); return text.slice(from, to); };
  assert.equal(extract(source, 'function promiseRm(', 'function browserFailureSummary('), extract(oldSource, 'function promiseRm(', 'function browserFailureSummary('));
  assert.equal(extract(source, 'function retainOwned(', 'async function checkRetentionContract('), extract(oldSource, 'function retainOwned(', 'async function checkRetentionContract('));
  const caseAssertions = text => extract(text, 'async function browserCases(', 'function bundleModules(').split(/\r?\n/).filter(line => line.includes('assert.'));
  assert.deepEqual(caseAssertions(source), caseAssertions(oldSource), 'SIX_SCENARIO_ASSERTIONS_CHANGED');
  const actualCases = extract(source, 'async function browserCases(', 'async function run()');
  assert(actualCases.includes("assert.equal(after.tasks.length, before.tasks.length + 1, 'TASK_COUNT_MISMATCH')"));
  const proof = { status: 'fixture-fix-pure-contract-passed', prepared: bind(preparedPath), tool: bind(__filename), server: bind(serverPath), node: bind(process.execPath),
    nullInitRed: true, htmlLightNoInitNeeded: true, legacyReadOpenRed: true, realCreateReadStreamGreen: true, assets: bytes,
    rejects: denied, nativeThisArgsCallbackReturnPreserved: true, numericReadOnlyPassed: true, badAssetHashRejected: true, otherServerGuardsUnchanged: true,
    inheritedPromise: bind(path.join(evidence, 'alarm-review-real-entry-browser-contract-20261006-v1.json')), inheritedRetention: bind(path.join(evidence, 'alarm-review-real-entry-browser-retention-contract-20261006-v3.json')),
    serviceStarted: false, browserStarted: false, compiled: false, elapsedMs: Date.now() - started, monotonicElapsedMs: performance.now() - mono };
  const output = path.join(evidence, 'alarm-review-real-entry-fixture-fix-contract-20261006-v1.json');
  assert(!fs.existsSync(output), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(output, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, sha256: hash(output), elapsedMs: proof.elapsedMs, monotonicElapsedMs: proof.monotonicElapsedMs }));
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
  const nativePromiseRm = fs.promises.rm;
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
  fs.promises.rm = promiseRm(nativePromiseRm, parentWrite, () => { parentPolicy.rejectedWrites++; throw new Error('RECURSIVE_RM_REJECTED'); });
  const renameSync = fs.renameSync; fs.renameSync = function (from, to) { parentWrite(from); parentWrite(to); return renameSync.call(this, from, to); };
  const rmSync = fs.rmSync; fs.rmSync = function (file, options) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rmSync.call(this, file, options); };
  for (const module of [fs, fs.promises]) { const open = module.open; module.open = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return open.call(this, file, flags, ...args); }; }
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (typeof fs[name] === 'function') fs[name] = () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (typeof fs.promises[name] === 'function') fs.promises[name] = async () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  const began = Date.now(), observations = [], artifacts = [], phases = {}, diagnostics = []; let child, browser, serverReady = false, outcome = 'failed', errorCode, state, closureModules, compileStartedAt, stage = 'asset-reuse';
  const safeCode = diagnosticCode;
  const numericPolicy = value => value && ['networkRejected', 'writesRejected', 'allowedConnections'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ? Object.fromEntries(['networkRejected', 'writesRejected', 'allowedConnections'].map(key => [key, value[key]])) : 'unknown';
  const cleanupState = { ownedDirectory: directory, ownerPid: process.pid, childPid: null, ownedDirectoryRemoved: false, childClosed: false, portRebound: false, retainedDirectory: undefined };
  function artifact(name) { const file = path.join(evidence, 'alarm-review-real-entry-fixture-fix-v1-' + name); assert(!fs.existsSync(file), 'ARTIFACT_EXISTS'); artifacts.push(file); return file; }

  const journalPath = path.join(evidence, 'alarm-review-real-entry-fixture-fix-journal-20261006-v1.json'), journal = { preparedSha256: hash(preparedPath), ownerPid: process.pid, events: [] };
  function checkpoint(event, details = {}) {
    journal.events.push({ event, stage, elapsedMs: Date.now() - began, ...details }); journal.phases = phases; journal.parentPolicy = parentPolicy; journal.childPid = child?.pid;
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  }
  const uncaught = error => checkpoint('uncaught-observed', { failure: browserFailureSummary(error) });
  process.on('uncaughtExceptionMonitor', uncaught);

  try {
    checkpoint('asset-reuse-begin');
    const reuseStarted = Date.now();
    for (const item of prepared.reusedAssets) { assertReusedAsset(item); fs.writeFileSync(path.join(output, item.name), fs.readFileSync(item.file)); }
    const assets = fs.readdirSync(output).map(name => ({ name, sha256: hash(path.join(output, name)) }));
    assert.deepEqual(assets.slice().sort((a, b) => a.name.localeCompare(b.name)), prepared.reusedAssets.map(x => ({ name: x.name, sha256: x.sha256 })).sort((a, b) => a.name.localeCompare(b.name)));
    preserveAssets(phases, assets); phases.assetReuseMs = Date.now() - reuseStarted; phases.compilerExecuted = false; checkpoint('asset-reuse-complete');
    stage = 'isolated-server-start'; const cp = require('node:child_process'), pending = new Map(); let seq = 0;
    child = cp.fork(path.join(root, 'test/visual/alarm-review-fixture-fix-v1/server.cjs'), [directory], { execPath: process.execPath, cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    cleanupState.childPid = child.pid; checkpoint('server-start'); const serverStartedAt = Date.now();
    child.on('message', value => { if (value?.event === 'ready') { serverReady = true; phases.childPolicy = numericPolicy(value.policy); } if (value?.event === 'closed') phases.childPolicy = numericPolicy(value.policy); if (value?.id && pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); } });
    const ready = observeServerReady(child, event => { diagnostics.push({ stage, ...event }); checkpoint(event.event, { observedStage: event.stage }); });
    await ready; phases.serverStartMs = Date.now() - serverStartedAt; checkpoint('server-ready');
    const control = message => new Promise((resolve, reject) => { const id = String(++seq); const timer = setTimeout(() => { pending.delete(id); reject(new Error('CONTROL_TIMEOUT')); }, 5000); pending.set(id, { resolve, timer }); child.send({ ...message, id }); });
    const { chromium } = require('playwright-core');
    stage = 'browser-launch'; assert.equal(hash(prepared.browser.executablePath), prepared.browser.sha256, 'BROWSER_BINARY_DRIFT');
    checkpoint('browser-launch');
    browser = await chromium.launch({ executablePath: prepared.browser.executablePath, headless: true, env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory } });
    assert.equal(browser.version(), prepared.browser.version, 'BROWSER_VERSION_DRIFT');
    phases.browserRuntime = { version: browser.version(), executableSha256: prepared.browser.sha256 }; checkpoint('browser-ready');
    stage = 'browser-six-scenarios';
    const browserStart = Date.now(); phases.browserProof = {}; let stopPageError; const firstPageError = new Promise((resolve, reject) => { stopPageError = reject; }); checkpoint('browser-six-scenarios');
    try { await Promise.race([browserCases(browser, control, artifact, observations, phases.browserProof, checkpoint, stopPageError), firstPageError]); } finally { phases.browserMs = Date.now() - browserStart; checkpoint('browser-six-scenarios-settled'); }
    const rawState = await control({ kind: 'state' }); state = { policy: rawState.policy ? { networkRejected: rawState.policy.networkRejected, writesRejected: rawState.policy.writesRejected, allowedConnections: rawState.policy.allowedConnections } : 'unknown', gateTimeouts: rawState.gateTimeouts, taskCount: Array.isArray(rawState.tasks) ? rawState.tasks.length : null }; assert.equal(state.policy.networkRejected, 0); assert.equal(state.policy.writesRejected, 0); assert.equal(state.gateTimeouts, 0); assert.equal(parentPolicy.rejectedNetwork, 0); assert.equal(parentPolicy.rejectedWrites, 0); assert.equal(observations.length, 6);
    outcome = 'passed';
  } catch (error) { errorCode = /^[A-Z0-9_:\-/\.]{1,160}$/.test(error.message) ? error.message : 'FIXTURE_EXECUTION_FAILED'; diagnostics.push({ stage, code: safeCode(error), errorCode, failure: browserFailureSummary(error) }); checkpoint('execution-failed', { failure: browserFailureSummary(error) }); }
  finally {
    if (compileStartedAt && phases.compileMs === undefined) phases.compileMs = Date.now() - compileStartedAt;
    let cleanupFailed = false;
    async function cleanStep(name, action) { try { await action(); } catch (error) { cleanupFailed = true; outcome = 'failed'; errorCode = errorCode || 'FIXTURE_CLEANUP_FAILED'; diagnostics.push({ stage: name, code: safeCode(error) }); } }
    await cleanStep('page-contexts-close', async () => { if (phases.browserProof?.closeContexts) await phases.browserProof.closeContexts(); });
    await cleanStep('browser-close', async () => { if (browser) await browser.close(); });
    await cleanStep('owned-server-close', async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const releaseClose = queueSafeClose(child, serverReady);
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('OWNED_SERVER_CLEANUP_TIMEOUT_NO_FORCE_KILL')), 12000); child.once('exit', () => { clearTimeout(timer); releaseClose(); resolve(); }); });
      }
      cleanupState.childClosed = !child || child.exitCode !== null || child.signalCode !== null;
    });
    await cleanStep('source-after-run', async () => { const currentDrift = prepared.inputs.filter(item => hash(path.resolve(root, item.file)) !== item.sha256); if (currentDrift.length) { outcome = 'failed'; errorCode = 'INPUT_DRIFT_AFTER_RUN'; } });
    const retention = retainOwned(directory, cleanupState); outcome = retention.outcome; errorCode = errorCode || retention.errorCode;
    await cleanStep('port-rebound', async () => { await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); }); cleanupState.portRebound = true; });
    const result = { kind: prepared.kind, outcome, errorCode, preparedSha256: hash(preparedPath), fingerprint: prepared.fingerprint, node: prepared.node, browser: prepared.browser, phases, diagnostics, observations, state, parentPolicy, compilerModules: closureModules, artifacts: artifacts.filter(file => fs.existsSync(file)).map(bind), childPid: child?.pid, cleanup: cleanupState, elapsedMs: Date.now() - began, dependencyProofGap: prepared.dependencyEvidence.gap, productionAppShellCovered: false, externalSchemaCovered: false };
    checkpoint('cleanup-settled', { outcome, errorCode, cleanup: { childClosed: cleanupState.childClosed, portRebound: cleanupState.portRebound, ownedDirectoryRemoved: cleanupState.ownedDirectoryRemoved } }); process.removeListener('uncaughtExceptionMonitor', uncaught);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ outcome, errorCode, result: relative(resultPath), sha256: hash(resultPath), elapsedMs: result.elapsedMs }) + '\n');
    if (outcome !== 'passed') process.exitCode = 1;
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--check-fixture-contract')) checkFixtureFixContract().catch(() => { process.stderr.write('FIXTURE_FIX_PURE_CONTRACT_FAILED\n'); process.exitCode = 1; });
else if (process.argv.includes('--check-cdp-contract')) checkCdpContract().catch(() => { process.stderr.write('CDP_PURE_CONTRACT_FAILED\n'); process.exitCode = 1; });
else if (process.argv.includes('--check-pageerror-contract')) checkPageErrorContract().catch(() => { process.stderr.write('PAGEERROR_PURE_CONTRACT_FAILED\n'); process.exitCode = 1; });
else if (process.argv.includes('--check-retention-contract')) checkRetentionContract().catch(error => { console.error(diagnosticCode(error)); process.exitCode = 1; });
else if (process.argv.includes('--check-diagnostics-contract')) checkDiagnosticsContract();
else if (process.argv.includes('--run')) run().catch(() => { process.stderr.write('FIXTURE_PRECONDITION_OR_CLEANUP_FAILED\n'); process.exitCode = 1; });
else throw new Error('EXPLICIT_PREPARE_OR_APPROVED_RUN_REQUIRED');
