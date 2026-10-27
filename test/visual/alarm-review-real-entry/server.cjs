'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const host = '127.0.0.1', port = 39894, origin = `http://${host}:${port}`;
let bootStage = 'early-isolation';
const boundary = path.join(__dirname, 'platform-boundaries.tsx');
const sdk = path.join(root, 'node_modules/@lark-apaas/client-toolkit/lib');
const aliases = {
  '@lark-apaas/client-toolkit/logger$': boundary,
  '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$': boundary,
  '@lark-apaas/client-toolkit/dataloom$': boundary,
  [path.join(sdk, 'apis/logger.js') + '$']: boundary,
  [path.join(sdk, 'logger/selected-logs.js') + '$']: boundary,
  '@lark-apaas/observable-web$': boundary,
  '@lark-apaas/internal-slardar$': boundary,
};
function compilerOptions(output) {
  const { DefinePlugin } = require('@rspack/core');
  return { context: root, mode: 'development', devtool: false, target: 'web',
    entry: path.join(__dirname, 'entry.tsx'), cache: false,
    output: { path: output, filename: 'app.js', cssFilename: 'app.css', publicPath: '/' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { ...aliases, '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared') } },
    module: { rules: [
      { test: /\.svg$/, type: 'asset/inline' },
      { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
      { test: /\.css$/, type: 'css/auto', use: { loader: 'postcss-loader', options: { postcssOptions: { plugins: { '@tailwindcss/postcss': {} } } } } },
    ] }, experiments: { css: true }, plugins: [new DefinePlugin({ 'process.env.CLIENT_BASE_PATH': JSON.stringify('') })],
  };
}
function isolate(directory) {
  if (!path.isAbsolute(directory) || /[^\x20-\x7e]/.test(directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('ASCII_OWNED_DIRECTORY_REQUIRED');
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  if (marker.scope !== 'alarm-review-real-entry' || marker.pid !== process.ppid || marker.directory !== fs.realpathSync(directory)) throw new Error('FIXTURE_OWNER_MISMATCH');
  const kept = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const encoded = password => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(password, salt, 32).toString('base64')}`; };
  // All values are established before importing any application or ConfigModule.
  process.env = { ...kept, TEMP: directory, TMP: directory, NODE_ENV: 'test',
    LOCAL_ACCESS_CONTROL_ENABLED: 'true', LOCAL_ACCESS_COOKIE_SECURE: 'false',
    ACCESS_CONFIGURATION_FILE: path.join(directory, 'configuration.json'), ALARM_REVIEW_LEDGER_PATH: path.join(directory, 'ledger.json'),
    LOCAL_ACCESS_SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
    LOCAL_ADMIN_PASSWORD_HASH: encoded('synthetic-entry-admin-123'), LOCAL_EDITOR_PASSWORD_HASH: encoded('synthetic-entry-editor-123'),
    PUBLIC_BASE_URL: origin, FEISHU_APP_ID: 'cli_synthetic_entry', FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false' };
  const policy = { networkRejected: 0, writesRejected: 0, allowedConnections: 0, environmentBeforeImports: true, protectedBeforeImports: true };
  const denied = () => { policy.networkRejected++; throw new Error('FIXTURE_NETWORK_REJECTED'); };
  const endpoint = (address, value) => { if (address !== host || Number(value) !== port) denied(); };
  const net = require('node:net'), tls = require('node:tls'), dns = require('node:dns');
  function check(args) {
    const values = Array.isArray(args[0]) ? args[0] : args, first = values[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) { if (first.path) denied(); endpoint(first.host, first.port); }
    else if (typeof first === 'number') endpoint(values[1], first); else denied();
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { check(args); policy.allowedConnections++; return connect.apply(this, args); };
  tls.connect = denied;
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    const previous = dns[name]; if (typeof previous === 'function') dns[name] = function (address, ...args) { if (name !== 'lookup' || address !== host) denied(); return previous.call(this, address, ...args); };
    if (typeof dns.promises[name] === 'function') dns.promises[name] = async () => denied();
    for (const Resolver of [dns.Resolver, dns.promises.Resolver]) if (typeof Resolver?.prototype[name] === 'function') Resolver.prototype[name] = denied;
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.origin !== origin || url.username || url.password || options?.redirect === 'follow') denied(); return previousFetch(input, { ...options, redirect: 'error' }); };
  for (const module of ['node:http', 'node:https']) for (const name of ['get', 'request']) {
    const target = require(module), original = target[name]; target[name] = function (input, ...args) {
      if (module === 'node:https') denied();
      if (typeof input === 'string' || input instanceof URL) { const url = new URL(input); if (url.origin !== origin || url.username || url.password) denied(); if (args[0] && typeof args[0] === 'object' && ['host', 'hostname', 'port', 'socketPath', 'createConnection'].some(key => key in args[0])) denied(); }
      else { if (!input || input.socketPath || input.createConnection) denied(); endpoint(input.hostname || input.host, input.port); }
      return original.call(this, input, ...args);
    };
  }
  const cp = require('node:child_process'); for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = denied;
  require('node:dgram').createSocket = denied; require('node:worker_threads').Worker = denied;
  const ownedFds = new Set();
  const rejectWrite = () => { policy.writesRejected++; throw new Error('FIXTURE_WRITE_REJECTED'); };
  function writable(file) {
    if (typeof file === 'number') { if (!ownedFds.has(file)) rejectWrite(); return; }
    if (typeof file !== 'string') rejectWrite();
    const resolved = path.resolve(file);
    if (resolved === directory) return;
    if (path.dirname(resolved) !== directory || !/^(configuration|ledger)\.json(?:\.[A-Za-z0-9_-]+\.tmp|\.tmp|\.lock(?:\.recovery)?)?$/.test(path.basename(resolved))) rejectWrite();
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) rejectWrite();
  }
  const open = fs.openSync, close = fs.closeSync;
  fs.openSync = function (file, flags, ...args) { const writing = typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags); if (writing) writable(file); const fd = open.call(this, file, flags, ...args); if (writing) ownedFds.add(fd); return fd; };
  fs.closeSync = function (fd) { try { return close.call(this, fd); } finally { ownedFds.delete(fd); } };
  for (const name of ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync']) { const original = fs[name]; fs[name] = function (file, ...args) { writable(file); return original.call(this, file, ...args); }; }
  const rename = fs.renameSync; fs.renameSync = function (from, to) { writable(from); writable(to); return rename.call(this, from, to); };
  const rm = fs.rmSync; fs.rmSync = function (file, options) { writable(file); if (options?.recursive) rejectWrite(); return rm.call(this, file, options); };
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'open', 'createWriteStream', 'mkdtemp', 'mkdtempSync']) fs[name] = rejectWrite;
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'open', 'mkdtemp']) fs.promises[name] = async () => rejectWrite();
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (typeof fs[name] === 'function') fs[name] = rejectWrite;
  for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (typeof fs.promises[name] === 'function') fs.promises[name] = async () => rejectWrite();
  return policy;
}
async function serve(directory) {
  const policy = isolate(directory);
  bootStage = 'application-imports';
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
  const load = file => require(path.join(root, file));
  const { UnifiedAccessModule } = load('server/common/access/unified-access.module.ts');
  const { AccessConfigurationDirectory } = load('server/common/access/access-configuration.directory.ts');
  const { AccessConfigurationCardDirectory } = load('server/common/access/access-configuration.card-directory.ts');
  const { AlarmReviewController } = load('server/modules/bitable-sync/alarm-review.controller.ts');
  const { AlarmReviewService } = load('server/modules/bitable-sync/alarm-review.service.ts');
  const { AlarmReviewStore, ALARM_REVIEW_LEDGER_PATH } = load('server/modules/bitable-sync/alarm-review.store.ts');
  const { AlarmReviewGateway } = load('server/modules/bitable-sync/alarm-review.gateway.ts');
  const { BitableSyncService } = load('server/modules/bitable-sync/bitable-sync.service.ts');
  const { TodayOperationsAlarmService } = load('server/modules/bitable-sync/today-operations-alarm.service.ts');
  const data = require('./data.ts');
  const gateway = { preflight: async () => {}, resolveResponsibleUserId: async id => id,
    syncRecord: async (_id, outcome, id, _version, reply) => ({ 人工复核结果: outcome, 复核回复: reply || '', 复核责任人: [{ id }] }) };
  bootStage = 'nest-module-compile';
  const module = await require('@nestjs/testing').Test.createTestingModule({ imports: [UnifiedAccessModule], controllers: [AlarmReviewController], providers: [
    AlarmReviewService, AlarmReviewStore, { provide: ALARM_REVIEW_LEDGER_PATH, useValue: path.join(directory, 'ledger.json') },
    { provide: AlarmReviewGateway, useValue: gateway }, { provide: BitableSyncService, useValue: { getCachedActivePersonnelDirectory: async () => ({ personnel: data.personnel }) } },
    { provide: TodayOperationsAlarmService, useValue: { patchHumanReview: (id, fields) => { const item = data.items.find(value => value.id === id); if (item) item.humanReview = { outcome: fields.人工复核结果, customReply: fields.复核回复 || undefined, responsibleName: data.personnel.find(person => person.openId === fields.复核责任人[0].id)?.name || '合成人员', version: 'synthetic-reviewed' }; } } },
  ] }).overrideProvider(AccessConfigurationDirectory).useValue({ read: async () => ({ appId: 'cli_synthetic_entry', people: [], snapshotAt: Date.now() }), assertKnown: async () => {} })
    .overrideProvider(AccessConfigurationCardDirectory).useValue({ read: async () => ({ members: [] }) }).compile();
  const app = module.createNestApplication({ logger: false });
  const express = app.getHttpAdapter().getInstance();
  const counts = {}, responses = []; const gates = { people: false, accepted: false }; const held = [], gateTimers = {};
  let gateTimeouts = 0;
  function release(name) { gates[name] = false; clearTimeout(gateTimers[name]); for (let i = held.length - 1; i >= 0; i--) if (held[i].name === name) { const item = held.splice(i, 1)[0]; item.send(item.body); } }
  const reviewRoot = '/api/bitable/alarm-human-reviews';
  const allowedWrites = (method, url) => method === 'POST' && ['/api/access/login', '/api/access/logout', '/api/access/configuration/accounts', reviewRoot].includes(url) || method === 'POST' && new RegExp('^' + reviewRoot + '/alarm-review-task-[A-Za-z0-9-]+/retry$').test(url);
  express.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !allowedWrites(req.method, req.path)) { policy.writesRejected++; return res.status(405).json({ message: 'UNKNOWN_FIXTURE_WRITE_REJECTED' }); }
    if (req.path.startsWith('/api/')) { const key = `${req.method} ${req.path}`; counts[key] = (counts[key] || 0) + 1; res.on('finish', () => responses.push({ method: req.method, path: req.path, status: res.statusCode })); }
    const send = res.json.bind(res);
    res.json = body => {
      const name = req.path === reviewRoot + '/people' && req.method === 'GET' && res.statusCode === 200 ? 'people' : req.path === reviewRoot && req.method === 'POST' && res.statusCode === 201 ? 'accepted' : null;
      if (name && gates[name]) { held.push({ name, send, body }); process.send?.({ event: 'held', name, durable: name === 'accepted' && fs.existsSync(path.join(directory, 'ledger.json')) }); return res; }
      return send(body);
    };
    next();
  });
  const reads = {
    '/api/bitable/today-operations-overview': () => data.overview, '/api/bitable/today-operations-kpis': () => data.kpis,
    '/api/attendance/today': () => data.attendance, '/api/bitable/campus-operations-dashboard': () => data.campus,
  };
  for (const [url, value] of Object.entries(reads)) express.get(url, (_req, res) => res.json(value()));
  express.get('/api/bitable/today-operations-alarms', (req, res) => res.json(data.alarms(req.query)));
  express.get('/api/sealing-info/:year', (_req, res) => res.json(data.sealing));
  express.use(require('express').static(path.join(directory, 'bundle')));
  express.use('/assets', require('express').static(path.join(root, 'client/public/assets')));
  express.get('/today-operations-panorama', (_req, res) => res.type('html').send('<!doctype html><html lang="zh-CN" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'));
  // Unknown reads are errors, never synthetic success or passthrough to production.
  express.use((req, res, next) => req.path.startsWith('/api/') && !req.path.startsWith('/api/access/') && !req.path.startsWith(reviewRoot) ? res.status(404).json({ message: 'UNKNOWN_FIXTURE_READ' }) : next());
  process.on('message', async message => {
    if (message?.kind === 'gate' && ['people', 'accepted'].includes(message.name)) { release(message.name); if (message.hold) { gates[message.name] = true; gateTimers[message.name] = setTimeout(() => { gateTimeouts++; release(message.name); }, 9000); } process.send?.({ event: 'gate', id: message.id }); }
    else if (message?.kind === 'state') { const ledger = fs.existsSync(path.join(directory, 'ledger.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'ledger.json'), 'utf8')) : { tasks: [] }; process.send?.({ event: 'state', id: message.id, counts, responses, policy, gateTimeouts, tasks: ledger.tasks.map(task => ({ id: task.id, items: task.items.map(item => ({ recordId: item.recordId, state: item.state })), outcome: task.outcome, customReply: task.customReply, responsibleRecordId: task.responsibleRecordId })) }); }
    else if (message?.kind === 'close') { release('people'); release('accepted'); await app.close(); process.send?.({ event: 'closed', policy }); process.disconnect(); }
    else throw new Error('UNKNOWN_FIXTURE_CONTROL');
  });
  process.once('disconnect', () => { release('people'); release('accepted'); void app.close().catch(() => { process.exitCode = 1; }); });
  bootStage = 'nest-http-listen';
  await app.listen(port, host);
  process.send?.({ event: 'ready', pid: process.pid, origin, policy });
}
module.exports = { root, origin, port, aliases, compilerOptions, serve };
if (require.main === module) serve(process.argv[2]).catch(error => { process.send?.({ event: 'failed', reason: 'ISOLATED_SERVER_START_FAILED', stage: bootStage, code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'NO_SAFE_ERROR_CODE' }); process.exitCode = 1; if (process.connected) process.disconnect(); });
