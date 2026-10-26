'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { verifyBundleReads, bundleReadOpen } = require('./alarm-review-overlay-fix-v1/server.cjs');
const root = path.resolve(__dirname, '../..');
const assets = [
  ['app.js', '80609150ce3df86f4834e38efe04c360aab61c862360cffeeaf1595e20b0395a'],
  ['app.css', 'f8126550e2aa9ea24e702d230e86d447ded0b2685fd0714c3a916d3eeca0f64a'],
];
const output = path.join(root, 'output/admin-configuration-check/browser-production');
function assetProof(directory = output) {
  return verifyBundleReads(assets.map(([name, sha256]) => ({ file: path.join(directory, name), sha256 })));
}
function loopback(host, port) {
  if (host !== '127.0.0.1' || Number(port) !== 43212) throw new Error('PERF_NETWORK_REJECTED');
}
function ownedFile(file, directory) {
  if (typeof file !== 'string') throw new Error('PERF_WRITE_REJECTED');
  const target = path.resolve(file);
  if (target.slice(2).includes(':') || path.dirname(target) !== directory ||
      !/^configuration\.json(?:\.[A-Za-z0-9_-]+\.tmp|\.tmp|\.lock(?:\.recovery)?)?$/.test(path.basename(target)) ||
      fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('PERF_WRITE_REJECTED');
  return target;
}
const promiseReject = reject => async () => reject();
function install(directory) {
  if (!path.isAbsolute(directory) || /[^\x20-\x7e]/.test(directory) || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('PERF_OWNER_REJECTED');
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  if (marker.scope !== 'admin-foreground-performance' || marker.parentPid !== process.ppid || marker.directory !== directory) throw new Error('PERF_OWNER_REJECTED');
  const proofs = assetProof();
  for (const name of ['vnet-logo.png', 'vnet-logo-transparent.png']) {
    const file = path.join(root, 'client/public/assets', name);
    const expected = marker.publicAssets.find(item => item.file === file);
    if (!expected) throw new Error('PERF_PUBLIC_ASSET_UNBOUND');
    for (const [key, value] of verifyBundleReads([expected])) proofs.set(key, value);
  }
  const policy = { networkRejected: 0, writesRejected: 0, readsRejected: 0, compilerRunRejected: 0, events: [] };
  const reject = kind => { policy[kind]++; policy.events.push({ stage: 'isolated-server', category: kind }); throw new Error('PERF_' + kind.toUpperCase()); };
  const endpoint = (host, port) => { try { loopback(host, port); } catch { reject('networkRejected'); } };
  const net = require('node:net'); const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args, first = values[0];
    if (first && typeof first === 'object') { if (first.path) reject('networkRejected'); endpoint(first.host, first.port); }
    else endpoint(values[1], first);
    return connect.apply(this, args);
  };
  require('node:tls').connect = () => reject('networkRejected');
  const dns = require('node:dns');
  const lookup = dns.lookup;
  dns.lookup = function (address, ...args) { if (address !== '127.0.0.1') reject('networkRejected'); return lookup.call(this, address, ...args); };
  for (const name of Object.keys(dns)) if (name !== 'lookup' && /^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = () => reject('networkRejected');
  for (const name of Object.keys(dns.promises)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns.promises[name] === 'function') dns.promises[name] = promiseReject(() => reject('networkRejected'));
  for (const [Resolver, asyncResult] of [[dns.Resolver, false], [dns.promises.Resolver, true]]) for (const name of Object.getOwnPropertyNames(Resolver.prototype)) if (/^(resolve|reverse)/.test(name)) Resolver.prototype[name] = asyncResult ? promiseReject(() => reject('networkRejected')) : () => reject('networkRejected');
  const fetch = globalThis.fetch; globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== 'http://127.0.0.1:43212' || url.username || url.password || options?.redirect === 'follow') reject('networkRejected');
    return fetch(input, { ...options, redirect: 'error' });
  };
  for (const module of ['node:http', 'node:https']) for (const name of ['request', 'get']) {
    const api = require(module), original = api[name]; api[name] = function (input, ...args) {
      if (module === 'node:https') reject('networkRejected');
      if (typeof input === 'string' || input instanceof URL) { const url = new URL(input); endpoint(url.hostname, url.port); if (url.username || url.password) reject('networkRejected'); if (args[0] && ['host', 'hostname', 'port', 'socketPath', 'createConnection'].some(key => key in args[0])) reject('networkRejected'); }
      else { if (!input || input.socketPath || input.createConnection) reject('networkRejected'); endpoint(input.hostname || input.host, input.port); }
      return original.call(this, input, ...args);
    };
  }
  require('node:dgram').createSocket = () => reject('networkRejected');
  require('node:worker_threads').Worker = function () { reject('networkRejected'); };
  const cp = require('node:child_process'); for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => reject('networkRejected');
  const fds = new Set(), writing = flags => typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags);
  const noEnv = file => { if (typeof file === 'string' && /^\.env(?:$|\.)/.test(path.basename(file))) reject('readsRejected'); };
  const readSync = fs.readFileSync; fs.readFileSync = function (file, ...args) { noEnv(file); return readSync.call(this, file, ...args); };
  const readPromise = fs.promises.readFile; fs.promises.readFile = async function (file, ...args) { noEnv(file); return readPromise.call(this, file, ...args); };
  const writable = file => { try { if (typeof file === 'number') { if (!fds.has(file)) throw new Error(); } else ownedFile(file, directory); } catch { reject('writesRejected'); } };
  const open = fs.openSync, close = fs.closeSync;
  fs.openSync = function (file, flags, ...args) { noEnv(file); if (writing(flags)) writable(file); const fd = open.call(this, file, flags, ...args); if (writing(flags)) fds.add(fd); return fd; };
  fs.closeSync = function (fd) { try { return close.call(this, fd); } finally { fds.delete(fd); } };
  for (const name of ['writeFileSync', 'appendFileSync', 'writeSync', 'writevSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync', 'fsyncSync', 'fdatasyncSync']) if (fs[name]) { const original = fs[name]; fs[name] = function (file, ...args) { writable(file); return original.call(this, file, ...args); }; }
  const mkdir = fs.mkdirSync; fs.mkdirSync = function (file, options) {
    if (file === output || file === directory) { const stat = fs.lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) reject('writesRejected'); return undefined; }
    writable(file); return mkdir.call(this, file, options);
  };
  const rename = fs.renameSync; fs.renameSync = function (from, to) { writable(from); writable(to); return rename.call(this, from, to); };
  const rm = fs.rmSync; fs.rmSync = function (file, options) { writable(file); if (options?.recursive) reject('writesRejected'); return rm.call(this, file, options); };
  for (const name of ['writeFile', 'appendFile', 'write', 'writev', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'chown', 'utimes', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync', 'fdatasync', 'createWriteStream', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (fs[name]) fs[name] = () => reject('writesRejected');
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'rm', 'rename', 'truncate', 'chmod', 'chown', 'utimes', 'open', 'mkdtemp', 'copyFile', 'cp', 'link', 'symlink']) if (fs.promises[name]) fs.promises[name] = promiseReject(() => reject('writesRejected'));
  fs.open = bundleReadOpen(fs.open, proofs, () => reject('writesRejected'), summary => policy.events.push({ stage: 'asset-read', category: summary.category, resource: summary.resourceId }));
  const Module = require('node:module'), load = Module._load;
  Module._load = function (request, ...args) {
    const value = load.call(this, request, ...args);
    if (request !== '@rspack/core') return value;
    return { ...value, rspack: options => { const compiler = value.rspack(options); compiler.run = () => reject('compilerRunRejected'); return compiler; } };
  };
  Module.syncBuiltinESMExports();
  process.on('SIGINT', () => process.send?.({ event: 'perf-policy', policy }));
  process.on('message', message => { if (message?.event === 'perf-stop') { process.emit('SIGINT'); if (process.connected) process.disconnect(); } });
  process.on('exit', () => { if (process.connected) process.send?.({ event: 'perf-policy', policy }); });
  return policy;
}
module.exports = { assets, output, assetProof, loopback, ownedFile, promiseReject, install };
if (require.main !== module && process.env.ADMIN_PERF_OWNER_DIRECTORY) install(process.env.ADMIN_PERF_OWNER_DIRECTORY);
