'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..'), evidence = path.join(root, 'output/release-next-after-20261005-182903');
const serverFile = path.join(__dirname, 'server.cjs'), host = '127.0.0.1', port = 39894;
const preparedFile = path.join(evidence, 'alarm-review-startup-diagnostic-prepared-20261006.json');
const resultFile = path.join(evidence, 'alarm-review-startup-diagnostic-result-20261006.json');
const contractFile = path.join(evidence, 'alarm-review-startup-diagnostic-contract-20261006.json');
const planFile = path.join(root, 'docs/engineering/alarm-review-startup-diagnostic-plan-2026-10-06.md');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');
const bind = file => ({ file: relative(file), sha256: sha(file) });
const check = item => assert.equal(sha(path.resolve(root, item.file)), item.sha256, 'STARTUP_INPUT_DRIFT');
function summary(error) {
  const names = ['Error', 'TypeError', 'SyntaxError', 'AssertionError', 'UnknownDependenciesException'];
  const code = typeof error?.code === 'string' && /^(ERR_[A-Z0-9_]+|EACCES|ENOENT|EADDRINUSE|FIXTURE_[A-Z0-9_]+)$/.test(error.code) && !/TOKEN|SECRET|COOKIE|PASSWORD/.test(error.code) ? error.code : 'NO_SAFE_ERROR_CODE';
  const name = names.includes(error?.name) ? error.name : 'UnknownError';
  const reason = /Cannot find module/.test(String(error?.message || '')) ? 'Cannot find module (identifier omitted)' : 'UNKNOWN_REASON_NOT_EXPOSED';
  return { name, code, reason, reasonGap: reason === 'UNKNOWN_REASON_NOT_EXPOSED' };
}
function observeMethod(object, key, before, after, failed) {
  const original = object[key]; assert.equal(typeof original, 'function', 'OBSERVED_METHOD_SHAPE_CHANGED');
  object[key] = function (...args) {
    before(); let result;
    try { result = Reflect.apply(original, this, args); } catch (error) { failed(error); throw error; }
    if (result && typeof result.then === 'function') result.then(value => after(value), error => failed(error));
    else after(result);
    return result;
  };
}
function installCloseBridge(emitter, report) {
  const nativeOn = emitter.on, nativeEmit = emitter.emit; let installed = false, queued = null, delivered = false;
  const capture = message => {
    if (message?.kind !== 'close' || installed || delivered) return;
    if (!queued) { queued = message; report('early-close-cached'); }
  };
  Reflect.apply(nativeOn, emitter, ['message', capture]);
  emitter.on = function (event, listener) {
    const value = Reflect.apply(nativeOn, this, [event, listener]);
    if (this === emitter && event === 'message' && listener !== capture && !installed) {
      installed = true; report('original-control-handler-installed');
      if (queued && !delivered) {
        const message = queued; queued = null; delivered = true;
        queueMicrotask(() => { report('early-close-replayed-once'); Reflect.apply(nativeEmit, emitter, ['message', message]); });
      }
    }
    return value;
  };
  return () => ({ installed, queued: Boolean(queued), delivered });
}
function prepare() {
  const started = Date.now(), old = path.join(evidence, 'alarm-review-real-entry-prepared-20261006-v3.json');
  assert.equal(sha(old), '4221db5fc1e8d12fc02963cc855bd9d18f857562d02789ac83a120233b93c703');
  const previous = JSON.parse(fs.readFileSync(old, 'utf8')); previous.inputs.forEach(check);
  assert.equal(sha(process.execPath), previous.node.sha256, 'STARTUP_NODE_DRIFT');
  const files = new Set(previous.inputs.map(item => path.resolve(root, item.file)));
  const add = file => { assert(!fs.lstatSync(file).isSymbolicLink(), 'REPARSE_INPUT_REJECTED'); files.add(file); };
  for (const file of [__filename, planFile, old, path.join(evidence, 'alarm-review-startup-diagnostic-preparation-diff-20261006.txt')]) add(file);
  const failure = path.join(evidence, 'alarm-review-real-entry-result-20261006-v3.json');
  assert.equal(sha(failure), '48c6eeae9650840f92f5acfe029abe24da8eeeb0e45c9de71ec4f0289006b20b'); add(failure);
  assert.equal(sha(serverFile), '79bc708f91051f12681ab135d8f56d96a18a7b4dee881a8836f854fab90c9d03');
  const tools = ['ts-node', 'tsconfig-paths', 'reflect-metadata', '@nestjs/testing', '@nestjs/core', '@nestjs/common', 'express'];
  const toolEntries = tools.map(name => { const entry = require.resolve(name); add(entry); let folder = path.dirname(entry); while (!fs.existsSync(path.join(folder, 'package.json'))) folder = path.dirname(folder); add(path.join(folder, 'package.json')); return { name, entry: bind(entry) }; });
  add(path.join(root, 'node_modules/@nestjs/testing/testing-module.builder.js'));
  const freezeFiles = [['docs/engineering/alarm-review-custom-freeze-2026-10-05.json', 'directFiles'], ['output/admin-configuration-check/source-freeze.json', 'frozenInputs']];
  let frozenCount = 0; for (const [file, key] of freezeFiles) for (const item of JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[key]) { check({ file: item.file || item.path, sha256: item.sha256 }); frozenCount++; }
  new (require('node:vm').Script)(fs.readFileSync(__filename, 'utf8'), { filename: __filename });
  const inputs = [...files].sort().map(bind), fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { status: 'prepared-not-started', inputs, fingerprint, priorInputs: previous.inputs.length, frozenCount, node: previous.node, toolEntries,
    commands: { prepare: [process.execPath, relative(__filename), '--prepare'], contract: [process.execPath, relative(__filename), '--check-startup-contract'], startup: [process.execPath, relative(__filename), '--approved-startup-diagnostic'] },
    originalServer: bind(serverFile), originalFailure: bind(failure), originalDeadlineMs: 12000, observationBudgetMs: 60000,
    beganAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    gap: 'Exact observed entry bindings and previous 1385 inputs are not a full development dependency physical-tree proof; no CSS/component/browser/real Feishu/P95 verification.' };
  assert(!fs.existsSync(preparedFile), 'STARTUP_PREPARED_EXISTS'); fs.writeFileSync(preparedFile, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ prepared: relative(preparedFile), sha256: sha(preparedFile), inputs: inputs.length, fingerprint, frozenCount, elapsedMs: record.elapsedMs }));
}
async function contract() {
  const started = Date.now(), events = [], obj = { n: 3, method(a) { assert.equal(this, obj); return a + this.n; } };
  observeMethod(obj, 'method', () => events.push('begin'), value => events.push(value), () => events.push('error'));
  assert.equal(obj.method(4), 7); assert.deepEqual(events, ['begin', 7]);
  const exception = new Error('PRIVATE_SECRET'), throwing = { method() { throw exception; } };
  let observed; observeMethod(throwing, 'method', () => {}, () => {}, error => { observed = error; });
  assert.throws(() => throwing.method(), error => error === exception); assert.equal(observed, exception);
  const promised = Promise.resolve(obj), asyncObject = { method() { return promised; } };
  let resolved; observeMethod(asyncObject, 'method', () => {}, value => { resolved = value; }, () => {});
  assert.equal(asyncObject.method(), promised); await promised; assert.equal(resolved, obj);
  const rejection = new Error('PRIVATE_PASSWORD'), rejected = Promise.reject(rejection), rejects = { method() { return rejected; } };
  observeMethod(rejects, 'method', () => {}, () => {}, error => { observed = error; });
  assert.equal(rejects.method(), rejected); await assert.rejects(rejected, error => error === rejection); assert.equal(observed, rejection);
  const { EventEmitter } = require('node:events');
  const legacy = new EventEmitter(), close = { kind: 'close' }; legacy.emit('message', close); let lost = 0; legacy.on('message', () => lost++);
  assert.throws(() => assert.equal(lost, 1), { name: 'AssertionError' });
  const early = new EventEmitter(), reports = []; const bridge = installCloseBridge(early, event => reports.push(event));
  early.emit('message', close); early.emit('message', { kind: 'close' }); let called = 0;
  assert.equal(early.on('message', value => { assert.equal(value, close); called++; }), early);
  await new Promise(resolve => queueMicrotask(resolve)); assert.equal(called, 1); assert.deepEqual(bridge(), { installed: true, queued: false, delivered: true });
  assert.deepEqual(reports, ['early-close-cached', 'original-control-handler-installed', 'early-close-replayed-once']);
  const normal = new EventEmitter(); installCloseBridge(normal, () => {}); let received; normal.on('message', value => { received = value; });
  normal.emit('message', close); assert.equal(received, close); normal.emit('message', { event: 'ready' }); assert.deepEqual(received, { event: 'ready' });
  assert.throws(() => observeMethod({}, 'missing', () => {}, () => {}, () => {}), { name: 'AssertionError' });
  for (const privateText of ['secret=PRIVATE_SECRET', 'token=PRIVATE_TOKEN', 'password=PRIVATE_PASSWORD', 'Cookie: PRIVATE_COOKIE', 'https://private.example/path', 'C:\\Users\\private\\config', '/private/config', 'body{content:"PRIVATE_CSS"}']) assert(!JSON.stringify(summary({ message: privateText, code: privateText, stack: privateText, source: privateText })).includes(privateText));
  const record = { status: 'pure-startup-contract-passed', tool: bind(__filename), node: bind(process.execPath), prepared: bind(preparedFile), elapsedMs: Date.now() - started,
    methodIdentityArgsReturnThrowPreserved: true, originalLostCloseRejected: true, earlyCloseDeliveredOnce: true, normalReadyUnchanged: true, shapeMismatchRejected: true, sensitiveCases: 8, applicationStarted: false, listenCalled: false, compiled: false };
  assert(!fs.existsSync(contractFile), 'STARTUP_CONTRACT_EXISTS'); fs.writeFileSync(contractFile, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, elapsedMs: record.elapsedMs, sha256: sha(contractFile) }));
}
function child(directory) {
  const started = Date.now(), events = [], observed = new Set(); let stage = 'early-isolation', modulesTruncated = false;
  const send = value => { if (process.connected) process.send(value); };
  const report = (name, details = {}) => { const value = { event: 'diagnostic', name, stage, elapsedMs: Date.now() - started, ...details }; events.push(value); send(value); };
  const phase = value => { stage = value; report('phase'); };
  installCloseBridge(process, name => report(name));
  const nativeExit = process.exit; process.exit = function (code) { report('process-exit-called', { code: Number.isInteger(code) ? code : null }); return Reflect.apply(nativeExit, this, arguments); };
  process.on('uncaughtExceptionMonitor', error => report('uncaught-exception', { error: summary(error) }));
  const Module = require('node:module'), nativeLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file; try { file = Module._resolveFilename(request, parent, isMain); } catch { file = null; }
    if (typeof file === 'string' && path.isAbsolute(file) && file.startsWith(root + path.sep)) { if (observed.size < 3000) observed.add(relative(file)); else modulesTruncated = true; }
    const fromServer = parent?.filename === serverFile;
    if (fromServer && request === 'reflect-metadata') phase('application-imports');
    const top = fromServer && typeof file === 'string' && file.startsWith(root + path.sep);
    const before = Date.now(); if (top) report('module-begin', { module: relative(file) });
    let value; try { value = Reflect.apply(nativeLoad, this, arguments); } catch (error) { if (top) report('module-failed', { module: relative(file), ms: Date.now() - before, error: summary(error) }); throw error; }
    if (top) report('module-end', { module: relative(file), ms: Date.now() - before });
    if (fromServer && request === '@nestjs/testing') {
      assert(value?.Test, 'TEST_EXPORT_SHAPE_CHANGED');
      observeMethod(value.Test, 'createTestingModule', () => phase('nest-module-compile'), builder => {
        observeMethod(builder, 'compile', () => report('compile-begin'), module => {
          report('compile-end');
          observeMethod(module, 'createNestApplication', () => report('application-create-begin'), app => {
            report('application-create-end');
            const listen = app.listen; assert.equal(typeof listen, 'function', 'APP_LISTEN_SHAPE_CHANGED');
            app.listen = function (...args) { assert.equal(args[0], port, 'LISTEN_PORT_REJECTED'); assert.equal(args[1], host, 'LISTEN_HOST_REJECTED'); phase('nest-http-listen'); return Reflect.apply(listen, this, args); };
          }, error => report('application-create-failed', { error: summary(error) }));
        }, error => report('compile-failed', { error: summary(error) }));
      }, error => report('builder-failed', { error: summary(error) }));
    }
    return value;
  };
  report('child-entry');
  const server = require(serverFile); assert.equal(typeof server.serve, 'function');
  server.serve(directory).then(() => { report('serve-resolved'); send({ event: 'observed-modules', files: [...observed], truncated: modulesTruncated }); }, error => {
    report('serve-rejected', { error: summary(error) }); send({ event: 'observed-modules', files: [...observed], truncated: modulesTruncated });
    process.exitCode = 1; if (process.connected) process.disconnect();
  });
}
function parentIsolation(directory, policy) {
  const rejectNetwork = () => { policy.networkRejected++; throw new Error('STARTUP_NETWORK_REJECTED'); };
  const net = require('node:net'), connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { const a = Array.isArray(args[0]) ? args[0] : args, o = a[0]; if (!o || typeof o !== 'object' || o.host !== host || Number(o.port) !== port || o.path) rejectNetwork(); return Reflect.apply(connect, this, args); };
  require('node:tls').connect = rejectNetwork; require('node:dgram').createSocket = rejectNetwork;
  const dns = require('node:dns'); for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    if (dns[name]) { const native = dns[name]; dns[name] = function (nameOrHost, ...args) { if (name !== 'lookup' || nameOrHost !== host) rejectNetwork(); return Reflect.apply(native, this, [nameOrHost, ...args]); }; }
    if (dns.promises[name]) dns.promises[name] = rejectNetwork;
    for (const resolver of [dns.Resolver, dns.promises.Resolver]) if (resolver.prototype[name]) resolver.prototype[name] = rejectNetwork;
  }
  globalThis.fetch = rejectNetwork; require('node:worker_threads').Worker = rejectNetwork;
  const deniedWrite = () => { policy.writesRejected++; throw new Error('STARTUP_WRITE_REJECTED'); }, fds = new Set();
  const writable = file => { if (typeof file === 'number') { if (!fds.has(file)) deniedWrite(); return; } const target = path.resolve(String(file)), rel = path.relative(directory, target);
    if (target !== resultFile && (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep) || rel.includes(':'))) deniedWrite();
    if (target === resultFile && fs.existsSync(target)) deniedWrite();
    for (let cursor = target; cursor !== path.dirname(target === resultFile ? evidence : directory); cursor = path.dirname(cursor)) if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) deniedWrite();
  };
  const writing = flags => typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags);
  const open = fs.openSync, close = fs.closeSync; fs.openSync = function (file, flags, ...args) { if (writing(flags)) writable(file); const fd = Reflect.apply(open, this, [file, flags, ...args]); if (writing(flags)) fds.add(fd); return fd; };
  fs.closeSync = function (fd) { try { return Reflect.apply(close, this, [fd]); } finally { fds.delete(fd); } };
  for (const name of ['writeFileSync', 'appendFileSync', 'writeSync', 'writevSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'createWriteStream', 'mkdtempSync']) { const native = fs[name]; fs[name] = function (file, ...args) { writable(file); return Reflect.apply(native, this, [file, ...args]); }; }
  for (const target of [fs, fs.promises]) for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'truncate', 'chmod', 'open', 'mkdtemp', 'rename', 'rm', 'copyFile', 'cp', 'link', 'symlink']) if (target[name]) target[name] = deniedWrite;
  for (const name of ['renameSync', 'rmSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync']) fs[name] = deniedWrite;
  return rejectNetwork;
}
async function startup() {
  const start = Date.now(), prepared = JSON.parse(fs.readFileSync(preparedFile, 'utf8')); prepared.inputs.forEach(check); assert.equal(sha(process.execPath), prepared.node.sha256);
  assert(!fs.existsSync(resultFile), 'STARTUP_RESULT_EXISTS');
  const net = require('node:net'); await new Promise((resolve, reject) => { const p = net.createServer(); p.once('error', reject); p.listen(port, host, () => p.close(resolve)); });
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'alarm-review-startup-')); assert(!/[^\x20-\x7e]/.test(directory));
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ scope: 'alarm-review-real-entry', pid: process.pid, directory: fs.realpathSync(directory) })); fs.mkdirSync(path.join(directory, 'bundle'));
  process.env = { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), NODE_ENV: 'test', TEMP: directory, TMP: directory };
  const policy = { networkRejected: 0, writesRejected: 0 }; const rejectNetwork = parentIsolation(directory, policy);
  const cp = require('node:child_process'), nativeFork = cp.fork; let forked = false;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[key] = rejectNetwork;
  cp.fork = function (file, args, options) { if (forked || file !== __filename || args[0] !== '--child' || args[1] !== directory) rejectNetwork(); forked = true; return Reflect.apply(nativeFork, this, [file, args, options]); };
  const result = { status: 'diagnostic-failed', beganAt: new Date(start).toISOString(), parentPid: process.pid, directory, prepared: bind(preparedFile), events: [], policy, stderr: [], originalDeadlineMs: 12000, observationBudgetMs: 60000, originalRunReclassified: false, browserCovered: false, childClosed: false, directoryRemoved: false, portRebound: false };
  let processChild, timer12, timer60, moduleFiles = [], readyAt, childExited = false;
  let resolveState;
  try {
    processChild = cp.fork(__filename, ['--child', directory], { execPath: process.execPath, cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); result.childPid = processChild.pid;
    const forkAt = Date.now(); let stderrBytes = 0;
    processChild.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes <= 8192) { const value = summary({ message: chunk.toString() }); if (!value.reasonGap) result.stderr.push(value); } result.stderrBytes = stderrBytes; result.stderrTruncated = stderrBytes > 8192; });
    const ready = new Promise((resolve, reject) => {
      processChild.on('message', value => { if (value.event === 'diagnostic') result.events.push(value); else if (value.event === 'observed-modules') { moduleFiles = value.files; result.modulesTruncated = value.truncated; } else if (value.event === 'ready') { readyAt = Date.now() - forkAt; result.readyMs = readyAt; result.childPolicy = value.policy; result.events.push({ name: 'original-ready', elapsedMs: readyAt }); resolve(); } else if (value.event === 'state' && value.id === 'startup-state') resolveState?.(value); else if (value.event === 'closed') { result.childPolicy = value.policy; result.events.push({ name: 'original-closed', elapsedMs: Date.now() - forkAt }); } });
      processChild.once('exit', (code, signal) => { childExited = true; result.exitCode = code; result.signal = signal; result.events.push({ name: 'child-exit', code, signal, elapsedMs: Date.now() - forkAt }); if (!readyAt) reject(new Error('CHILD_EXIT_BEFORE_READY')); });
      timer12 = setTimeout(() => { result.originalDeadlineExceeded = !readyAt; result.events.push({ name: 'original-12s-observed', elapsedMs: Date.now() - forkAt }); }, 12000);
      timer60 = setTimeout(() => { result.observationBudgetExceeded = true; if (processChild.connected) processChild.send({ kind: 'close' }); reject(new Error('STARTUP_OBSERVATION_BUDGET_EXCEEDED')); }, 60000);
    });
    await ready; clearTimeout(timer12); clearTimeout(timer60); result.originalDeadlineExceeded = readyAt > 12000;
    const http = require('node:http');
    result.session = await new Promise((resolve, reject) => { const req = http.get({ hostname: host, port, path: '/api/access/session', headers: { Accept: 'application/json' } }, response => { let bytes = ''; response.on('data', chunk => { bytes += chunk; if (bytes.length > 8192) req.destroy(new Error('SESSION_RESPONSE_TOO_LARGE')); }); response.on('end', () => { try { const data = JSON.parse(bytes); assert.equal(response.statusCode, 200); assert.equal(data.role, 'guest'); resolve({ status: response.statusCode, role: data.role }); } catch (error) { reject(error); } }); }); req.setTimeout(5000, () => req.destroy(new Error('SESSION_TIMEOUT'))); req.on('error', reject); });
    const state = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('STARTUP_STATE_TIMEOUT')), 5000); resolveState = value => { clearTimeout(timer); resolve(value); }; processChild.send({ kind: 'state', id: 'startup-state' }); });
    assert.equal(state.tasks.length, 0, 'STARTUP_CREATED_TASK'); assert.equal(state.policy.networkRejected, 0); assert.equal(state.policy.writesRejected, 0);
    result.childPolicy = state.policy; result.taskCount = state.tasks.length; result.requests = state.responses;
    result.status = 'diagnostic-ready-session-verified';
  } catch (error) { result.failure = summary(error); result.failureCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'STARTUP_DIAGNOSTIC_FAILED'; }
  finally {
    clearTimeout(timer12); clearTimeout(timer60);
    if (processChild && !childExited) {
      if (processChild.connected) { result.events.push({ name: 'parent-close-sent', elapsedMs: Date.now() - start }); processChild.send({ kind: 'close' }); }
      await new Promise(resolve => { const timer = setTimeout(resolve, 12000); processChild.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    result.childClosed = !processChild || childExited;
    result.currentDrift = prepared.inputs.filter(item => sha(path.resolve(root, item.file)) !== item.sha256).map(item => item.file);
    result.observedModules = moduleFiles.map(file => { assert(!path.isAbsolute(file) && !file.split('/').includes('..')); return bind(path.resolve(root, file)); });
    result.observedOutsidePrepared = result.observedModules.filter(item => !prepared.inputs.some(input => input.file === item.file && input.sha256 === item.sha256)).map(item => item.file);
    if (result.childClosed) {
      try { const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); assert.equal(marker.pid, process.pid); assert.equal(marker.directory, fs.realpathSync(directory)); assert.equal(marker.scope, 'alarm-review-real-entry');
        function clean(folder) { assert(!fs.lstatSync(folder).isSymbolicLink()); for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); assert(!fs.lstatSync(file).isSymbolicLink()); if (entry.isDirectory()) { assert.equal(folder, directory); assert.equal(entry.name, 'bundle'); assert.equal(fs.readdirSync(file).length, 0); fs.rmdirSync(file); } else { assert(/^(owner|configuration|ledger)\.json$/.test(entry.name)); if (entry.name === 'ledger.json') assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0); fs.unlinkSync(file); } } fs.rmdirSync(folder); }
        clean(directory); result.directoryRemoved = true;
      } catch (error) { result.cleanupError = summary(error); }
    }
    try { await new Promise((resolve, reject) => { const p = net.createServer(); p.once('error', reject); p.listen(port, host, () => p.close(resolve)); }); result.portRebound = true; } catch (error) { result.portError = summary(error); }
    if (!result.childClosed || !result.directoryRemoved || !result.portRebound || result.currentDrift.length || policy.networkRejected || policy.writesRejected || result.childPolicy?.networkRejected || result.childPolicy?.writesRejected) result.status = 'diagnostic-failed';
    result.completedAt = new Date().toISOString(); result.elapsedMs = Date.now() - start;
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ status: result.status, result: relative(resultFile), sha256: sha(resultFile), elapsedMs: result.elapsedMs }));
    if (result.status !== 'diagnostic-ready-session-verified') process.exitCode = 1;
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--check-startup-contract')) contract().catch(error => { console.error(summary(error)); process.exitCode = 1; });
else if (process.argv.includes('--child')) child(process.argv[process.argv.indexOf('--child') + 1]);
else if (process.argv.includes('--approved-startup-diagnostic')) startup().catch(error => { console.error(summary(error)); process.exitCode = 1; });
else throw new Error('EXPLICIT_STARTUP_MODE_REQUIRED');
