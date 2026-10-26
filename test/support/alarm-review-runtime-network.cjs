'use strict';
// setupFiles executes before the spec imports any application module.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const kept = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'JEST_WORKER_ID', 'ALARM_REVIEW_RUNTIME_CACHE', 'ALARM_REVIEW_RUNTIME_RESULT', 'ALARM_REVIEW_RUNTIME_OBSERVATIONS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
// ConfigModule.forRoot is evaluated during imports, before beforeEach.
process.env = { ...kept, NODE_ENV: 'test', LOCAL_ACCESS_CONTROL_ENABLED: 'true', FEISHU_APP_ID: 'cli_synthetic_runtime', FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false' };
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const workers = require('node:worker_threads');
const policy = { denied: 0, allowedConnections: 0, installedBeforeApplicationImports: true, environmentIsolatedBeforeApplicationImports: true, rejectedWrites: 0 };
globalThis.__alarmReviewRuntimeNetwork = policy;
function deny() {
  policy.denied += 1;
  throw new Error('RUNTIME_TEST_NETWORK_POLICY_REJECTED');
}
function literal(host) { return host === '127.0.0.1' || host === '::1' || host === '[::1]'; }
function endpoint(host, port) {
  if (!literal(host) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) deny();
}
function connectTarget(args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    if (first.path) deny();
    endpoint(first.host, first.port);
  } else if (typeof first === 'number') endpoint(values[1], first);
  else deny();
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  connectTarget(args);
  policy.allowedConnections += 1;
  return originalConnect.apply(this, args);
};
const originalTls = tls.connect;
tls.connect = function (...args) { connectTarget(args); return originalTls.apply(this, args); };
function requestTarget(args, protocol) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    let url;
    try { url = new URL(first); } catch { deny(); }
    if (url.protocol !== protocol || url.username || url.password) deny();
    endpoint(url.hostname, url.port || (protocol === 'http:' ? 80 : 443));
    if (args[1] && typeof args[1] === 'object') {
      const options = args[1];
      if (options.socketPath || options.createConnection || options.hostname || options.host || options.port || options.protocol) deny();
    }
  } else if (first && typeof first === 'object') {
    if (first.socketPath || first.createConnection || (first.protocol && first.protocol !== protocol)) deny();
    endpoint(first.hostname || first.host, first.port || (protocol === 'http:' ? 80 : 443));
  } else deny();
}
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (...args) { requestTarget(args, protocol); return original.apply(this, args); };
  }
}
const originalFetch = globalThis.fetch;
if (typeof originalFetch !== 'function') throw new Error('RUNTIME_TEST_FETCH_UNAVAILABLE');
globalThis.fetch = async function (input, options) {
  const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
  requestTarget([value], 'http:');
  return originalFetch(input, options);
};
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  const original = dns[method];
  if (typeof original === 'function') dns[method] = function (host, ...args) {
    if (method !== 'lookup' || !literal(host)) deny();
    return original.call(this, host, ...args);
  };
  if (typeof dns.promises[method] === 'function') {
    const promiseOriginal = dns.promises[method];
    dns.promises[method] = async function (host, ...args) {
      if (method !== 'lookup' || !literal(host)) deny();
      return promiseOriginal.call(this, host, ...args);
    };
  }
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
    if (typeof Resolver?.prototype[method] === 'function') Resolver.prototype[method] = deny;
  }
}
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = deny;
dgram.createSocket = deny;
workers.Worker = deny;

// All application writes, including import-time writes, are contained in owned fixtures.
const ownedDirectories = new Set();
const ownedFds = new Set();
const evidenceRoot = path.resolve(__dirname, '../../output/release-next-after-20261005-182903');
const toolCacheRoot = process.env.ALARM_REVIEW_RUNTIME_CACHE ? path.resolve(process.env.ALARM_REVIEW_RUNTIME_CACHE) : '';
if (!toolCacheRoot || path.dirname(fs.realpathSync(toolCacheRoot)) !== fs.realpathSync(os.tmpdir()) ||
  !path.basename(toolCacheRoot).startsWith('alarm-review-runtime-tool-') || fs.lstatSync(toolCacheRoot).isSymbolicLink()) throw new Error('RUNTIME_TEST_TOOL_CACHE_OWNERSHIP_REJECTED');
const toolOwner = JSON.parse(fs.readFileSync(path.join(toolCacheRoot, 'owner.json'), 'utf8'));
if (toolOwner.pid !== process.ppid || toolOwner.scope !== 'one-cross-auth-suite') throw new Error('RUNTIME_TEST_TOOL_CACHE_OWNER_REJECTED');
const evidenceFiles = new Set([process.env.ALARM_REVIEW_RUNTIME_RESULT, process.env.ALARM_REVIEW_RUNTIME_OBSERVATIONS]
  .filter(Boolean).map(file => path.resolve(file)));
if ([...evidenceFiles].some(file => path.dirname(file) !== evidenceRoot)) throw new Error('RUNTIME_TEST_EVIDENCE_PATH_REJECTED');
const tempPrefix = path.join(os.tmpdir(), 'alarm-review-cross-auth-');
function rejectWrite() { policy.rejectedWrites += 1; throw new Error('RUNTIME_TEST_WRITE_POLICY_REJECTED'); }
function writable(file) {
  if (typeof file === 'number') { if (!ownedFds.has(file)) rejectWrite(); return; }
  if (typeof file !== 'string' && !(file instanceof URL)) rejectWrite();
  const target = path.resolve(file instanceof URL ? require('node:url').fileURLToPath(file) : file);
  if (evidenceFiles.has(target)) return;
  const cacheRelative = path.relative(toolCacheRoot, target);
  if (!path.isAbsolute(cacheRelative) && cacheRelative !== '..' && !cacheRelative.startsWith('..' + path.sep)) return;
  if (ownedDirectories.has(target)) return;
  if (!ownedDirectories.has(path.dirname(target)) || !/^(configuration|ledger)\.json(?:\.[A-Za-z0-9_-]+\.tmp|\.lock(?:\.recovery)?)?$/.test(path.basename(target))) rejectWrite();
}
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, options) {
  if (prefix !== tempPrefix || options) rejectWrite();
  const directory = mkdtemp.call(this, prefix);
  ownedDirectories.add(path.resolve(directory));
  return directory;
};
const open = fs.openSync;
fs.openSync = function (file, flags, ...args) {
  const writes = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(flags);
  if (writes) writable(file);
  const fd = open.call(this, file, flags, ...args);
  if (writes) ownedFds.add(fd);
  return fd;
};
const close = fs.closeSync;
fs.closeSync = function (fd) { try { return close.call(this, fd); } finally { ownedFds.delete(fd); } };
for (const method of ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync']) {
  const original = fs[method];
  fs[method] = function (file, ...args) { writable(file); return original.call(this, file, ...args); };
}
const rename = fs.renameSync;
fs.renameSync = function (from, to) { writable(from); writable(to); return rename.call(this, from, to); };
const rm = fs.rmSync;
fs.rmSync = function (file, options) { writable(file); if (options?.recursive) rejectWrite(); return rm.call(this, file, options); };
// These async writer routes are not used by the real stores in this suite.
for (const method of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'open', 'createWriteStream']) fs[method] = rejectWrite;
for (const method of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'open', 'mkdtemp']) fs.promises[method] = async function () { rejectWrite(); };
