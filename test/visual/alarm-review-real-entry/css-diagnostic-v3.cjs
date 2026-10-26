'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..'), evidence = path.join(root, 'output/release-next-after-20261005-182903');
const preparedPath = path.join(evidence, 'alarm-review-css-diagnostic-prepared-20261006-v3.json');
const resultPath = path.join(evidence, 'alarm-review-css-diagnostic-result-20261006-v3.json');
const planPath = path.join(root, 'docs/engineering/alarm-review-css-diagnostic-v3-plan-2026-10-06.md');
const previousPath = path.join(evidence, 'alarm-review-real-entry-prepared-20261006-v2.json');
const failedPath = path.join(evidence, 'alarm-review-real-entry-result-20261006.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const binding = file => ({ file: path.relative(root, file).replace(/\\/g, '/'), sha256: sha(file) });
const check = item => assert.equal(sha(path.resolve(root, item.file)), item.sha256, 'CSS_INPUT_DRIFT');
const presetPath = path.join(root, 'node_modules/@lark-apaas/fullstack-rspack-preset/lib/preset.js');
const presetSha = '709d396b94308abba5f9e80f4d95e0ac79e635b925f7203bd58a7923f9e88882';
function verifyPresetDigest(value) { assert.equal(value, presetSha, 'PRODUCTION_CSS_RESOLVER_DRIFT'); }
function createInspectorResolver(isDev) {
  assert.equal(typeof isDev, 'boolean', 'EXPLICIT_CSS_MODE_REQUIRED');
  return (id, _basedir) => {
    if (id === '@/inspector.dev.css') return isDev ? path.join(_basedir, '/inspector.dev.css') : [];
    return id;
  };
}
function validateResolution(isDev, id, basedir, actual) {
  const expected = id === '@/inspector.dev.css' ? (isDev ? path.join(basedir, '/inspector.dev.css') : []) : id;
  assert.deepEqual(actual, expected, 'INVALID_INSPECTOR_RESOLUTION');
}
const command = [process.execPath, 'test/visual/alarm-review-real-entry/css-diagnostic-v3.cjs', '--approved-css-probe'];
function prepare() {
  const began = Date.now(), previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
  previous.inputs.forEach(check);
  verifyPresetDigest(sha(presetPath));
  const frozenSets = [JSON.parse(fs.readFileSync(path.join(root, 'docs/engineering/alarm-review-custom-freeze-2026-10-05.json'), 'utf8')).directFiles, JSON.parse(fs.readFileSync(path.join(root, 'output/admin-configuration-check/source-freeze.json'), 'utf8')).frozenInputs];
  let frozenCount = 0; for (const set of frozenSets) for (const item of set) { check({ file: item.file || item.path, sha256: item.sha256 }); frozenCount++; }
  assert.equal(sha(previousPath), 'a50afa2254c1748c71d337205a689550fdbbd7063724b4974e8e132a5f1ac8dc');
  assert.equal(sha(failedPath), '291547a1253b4c3fcea1520d246fb998b8c4809a01386d3a903072ed8c6d30b5');
  const files = new Set(previous.inputs.map(item => path.resolve(root, item.file)));
  const add = file => { const absolute = path.resolve(root, file); assert(fs.statSync(absolute).isFile()); assert(!fs.lstatSync(absolute).isSymbolicLink()); files.add(absolute); };
  [__filename, planPath, previousPath, failedPath, presetPath, path.join(root, 'rspack.config.js'), path.join(root, 'rspack.hotfix.config.js')].forEach(add);
  const previousCss = JSON.parse(fs.readFileSync(path.join(evidence, 'alarm-review-css-diagnostic-prepared-20261006-v2.json'), 'utf8')); previousCss.inputs.forEach(check); previousCss.inputs.forEach(item => add(path.resolve(root, item.file)));
  for (const [file, expected] of [
    ['test/visual/alarm-review-real-entry/css-diagnostic.cjs', 'df528bdb7b4f0f8deff15447cac1f0c257751b0a3b0a9f226c02668c5439f67f'],
    ['docs/engineering/alarm-review-css-diagnostic-plan-2026-10-06.md', 'c2f19465e8e33c0df0132fb53706a43439bb5806574e49734dd3c00e3ca72af3'],
    ['output/release-next-after-20261005-182903/alarm-review-css-diagnostic-prepared-20261006.json', '5be457e6535213a5332d39851b411b5c566b0f307bcc039c0468252a2398c000'],
    ['output/release-next-after-20261005-182903/alarm-review-css-diagnostic-result-20261006.json', '02cb1c28cf9e0f49e4ce667a62ce0469450f1213d5a951700e5dee90fc2edf6d'],
    ['test/visual/alarm-review-real-entry/css-diagnostic-v2.cjs', '6c98df0b54ee9aa4507b02e99fb60ea2d4625044742a33ba12066cb3bbf81cfb'],
    ['docs/engineering/alarm-review-css-diagnostic-v2-plan-2026-10-06.md', 'e0772a0277577af3f9f7af4e0cdb1ccda5fa206b5923f35cf36c2d94cc524b68'],
    ['output/release-next-after-20261005-182903/alarm-review-css-diagnostic-prepared-20261006-v2.json', 'ea0ad49d78e1330962a462b490c1a072beab19d35bdcb28c4063e1f7446a2eb5'],
    ['output/release-next-after-20261005-182903/alarm-review-css-diagnostic-result-20261006-v2.json', 'abdda31286eabff4d1b9eea48a4a828b8302ca5a1dde25e8a03694fbc52bdcde'],
  ]) { assert.equal(sha(path.join(root, file)), expected, 'ORIGINAL_CSS_PROBE_DRIFT'); add(file); }
  const names = ['postcss-loader', 'postcss', 'postcss-import', 'autoprefixer', '@tailwindcss/postcss', '@tailwindcss/node', '@tailwindcss/oxide', 'tailwindcss', 'tailwindcss-animate', 'jiti', 'cosmiconfig', '@lark-apaas/fullstack-presets'];
  const tools = names.map(name => { const entry = require.resolve(name); add(entry); let directory = path.dirname(entry); while (!fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory); add(path.join(directory, 'package.json')); return { name, entry: binding(entry) }; });
  ['node_modules/postcss-loader/dist/cjs.js', 'node_modules/postcss-loader/dist/index.js', 'node_modules/postcss-loader/dist/utils.js', 'node_modules/postcss-loader/dist/options.json', 'node_modules/@tailwindcss/node/dist/esm-cache.loader.mjs'].forEach(add);
  const queue = ['client/src/index.css', 'client/src/inspector.dev.css', 'node_modules/@lark-apaas/client-toolkit/lib/index.css', 'node_modules/@lark-apaas/client-toolkit/lib/inspector.dev.css', 'node_modules/tailwindcss/index.css', 'node_modules/tw-animate-css/dist/tw-animate.css', 'node_modules/@lark-apaas/fullstack-presets/lib/index.js'].map(file => path.join(root, file)), seen = new Set();
  add('node_modules/tw-animate-css/package.json');
  while (queue.length) {
    const file = queue.pop(); if (seen.has(file)) continue; seen.add(file); add(file);
    const text = fs.readFileSync(file, 'utf8');
    const relativeImports = file.endsWith('.css') ? [...text.matchAll(/@import\s+["'](\.[^"']+)["']/g)].map(match => match[1]) : [...text.matchAll(/require\(["'](\.[^"']+)["']\)/g)].map(match => match[1]);
    for (const spec of relativeImports) { const base = path.resolve(path.dirname(file), spec); const next = [base, base + '.js', path.join(base, 'index.js')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()); if (next) queue.push(next); }
  }
  new (require('node:vm').Script)(fs.readFileSync(__filename, 'utf8'), { filename: __filename });
  const inputs = [...files].sort().map(binding), fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { status: 'prepared-not-executed', command, preparationCommand: [process.execPath, command[1], '--prepare'], inputs, fingerprint, priorInputs: previous.inputs.length, priorBusinessFrozen: frozenCount,
    node: { path: process.execPath, version: process.version, sha256: sha(process.execPath) }, tools, originalPrepared: binding(previousPath), originalFailure: binding(failedPath),
    productionResolver: { preset: binding(presetPath), mode: 'development', specialId: '@/inspector.dev.css' }, scope: 'One real PostCSS loader call on index.css; no Rspack, application, Nest, browser, network, installation or release',
    dependencyPhysicalTreeGap: 'Exact additional entries/relative imports are frozen, not a complete development dependency physical-tree proof',
    elapsedMs: Date.now() - began, preparedAt: new Date().toISOString() };
  assert(!fs.existsSync(preparedPath), 'CSS_PREPARED_EXISTS'); fs.writeFileSync(preparedPath, JSON.stringify(record, null, 2));
  process.stdout.write(JSON.stringify({ status: record.status, preparedSha256: sha(preparedPath), inputCount: inputs.length, fingerprint, elapsedMs: record.elapsedMs }) + '\n');
}
function installIsolation(directory, record) {
  process.env = { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), NODE_ENV: 'test', TEMP: directory, TMP: directory };
  const rejectNetwork = () => { record.policy.networkRejected++; throw Object.assign(new Error('CSS_PROBE_NETWORK_REJECTED'), { code: 'CSS_PROBE_NETWORK_REJECTED' }); };
  require('node:net').Socket.prototype.connect = rejectNetwork;
  require('node:net').Server.prototype.listen = rejectNetwork;
  require('node:tls').connect = rejectNetwork;
  for (const name of ['node:http', 'node:https']) for (const key of ['get', 'request', 'createServer']) require(name)[key] = rejectNetwork;
  const dns = require('node:dns');
  for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    if (dns[key]) dns[key] = rejectNetwork; if (dns.promises[key]) dns.promises[key] = rejectNetwork;
    for (const resolver of [dns.Resolver, dns.promises.Resolver]) if (resolver.prototype[key]) resolver.prototype[key] = rejectNetwork;
  }
  globalThis.fetch = rejectNetwork; require('node:dgram').createSocket = rejectNetwork;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[key] = rejectNetwork;
  require('node:worker_threads').Worker = rejectNetwork;
  const module = require('node:module'), nativeRegister = module.register;
  const hook = require('node:url').pathToFileURL(path.join(root, 'node_modules/@tailwindcss/node/dist/esm-cache.loader.mjs')).href;
  module.register = function (specifier, ...args) { if (String(specifier) !== hook) rejectNetwork(); record.tailwindResolveHookRegistered = true; return nativeRegister.call(this, specifier, ...args); };
  if (module.registerHooks) module.registerHooks = rejectNetwork;
  const ownedFds = new Set();
  const deniedWrite = () => { record.policy.writesRejected++; throw Object.assign(new Error('CSS_PROBE_WRITE_REJECTED'), { code: 'CSS_PROBE_WRITE_REJECTED' }); };
  function writable(file) {
    if (typeof file === 'number') { if (!ownedFds.has(file)) deniedWrite(); return; }
    const target = path.resolve(typeof file === 'string' ? file : Buffer.isBuffer(file) ? file.toString() : require('node:url').fileURLToPath(file));
    if (target === resultPath) { if (fs.existsSync(target)) deniedWrite(); for (let cursor = path.dirname(target); cursor !== path.dirname(root); cursor = path.dirname(cursor)) if (fs.lstatSync(cursor).isSymbolicLink()) deniedWrite(); return; }
    const relative = path.relative(directory, target); if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || relative.includes(':')) deniedWrite();
    for (let cursor = target; cursor !== path.dirname(directory); cursor = path.dirname(cursor)) if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) deniedWrite();
  }
  const writing = flags => typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags);
  const nativeOpen = fs.openSync, nativeClose = fs.closeSync;
  fs.openSync = function (file, flags, ...args) { if (writing(flags)) writable(file); const fd = nativeOpen.call(this, file, flags, ...args); if (writing(flags)) ownedFds.add(fd); return fd; };
  fs.closeSync = function (fd) { try { return nativeClose.call(this, fd); } finally { ownedFds.delete(fd); } };
  const callbackOpen = fs.open, callbackClose = fs.close;
  fs.open = function (file, flags, ...args) { if (writing(flags)) writable(file); const callback = args.pop(); return callbackOpen.call(this, file, flags, ...args, (error, fd) => { if (!error && writing(flags)) ownedFds.add(fd); callback(error, fd); }); };
  fs.close = function (fd, callback) { return callbackClose.call(this, fd, error => { if (!error) ownedFds.delete(fd); callback(error); }); };
  for (const name of ['writeFileSync', 'appendFileSync', 'writeSync', 'writevSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync', 'fsyncSync', 'fdatasyncSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync', 'lchmodSync', 'lchownSync', 'lutimesSync', 'createWriteStream', 'mkdtempSync']) {
    if (!fs[name]) continue; const original = fs[name]; fs[name] = function (file, ...args) { writable(file); return original.call(this, file, ...args); };
  }
  for (const target of [fs, fs.promises]) {
    for (const name of ['writeFile', 'appendFile', 'write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync', 'fdatasync', 'mkdir', 'unlink', 'rmdir', 'truncate', 'chmod', 'chown', 'utimes', 'lchmod', 'lchown', 'lutimes', 'mkdtemp']) { if (!target[name]) continue; const original = target[name]; target[name] = function (file, ...args) { writable(file); return original.call(this, file, ...args); }; }
    const rename = target.rename; target.rename = function (from, to, ...args) { writable(from); writable(to); return rename.call(this, from, to, ...args); };
    const rm = target.rm; target.rm = function (file, options, ...args) { writable(file); if (options?.recursive) deniedWrite(); return rm.call(this, file, options, ...args); };
    for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (target[name]) target[name] = deniedWrite;
  }
  const renameSync = fs.renameSync, rmSync = fs.rmSync;
  fs.renameSync = function (from, to) { writable(from); writable(to); return renameSync.call(this, from, to); };
  fs.rmSync = function (file, options) { writable(file); if (options?.recursive) deniedWrite(); return rmSync.call(this, file, options); };
  for (const name of ['copyFileSync', 'cpSync', 'linkSync', 'symlinkSync']) if (fs[name]) fs[name] = deniedWrite;
  const promiseOpen = fs.promises.open;
  fs.promises.open = async function (file, flags, ...args) {
    const canWrite = writing(flags); if (canWrite) writable(file); const handle = await promiseOpen.call(this, file, flags, ...args); if (canWrite) ownedFds.add(handle.fd);
    for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'sync', 'datasync', 'createWriteStream']) { const original = handle[name]; if (original) handle[name] = function (...values) { writable(handle.fd); return original.apply(this, values); }; }
    const close = handle.close; handle.close = async function () { const fd = handle.fd; try { return await close.call(this); } finally { ownedFds.delete(fd); } }; return handle;
  };
  module.syncBuiltinESMExports();
}
async function probe() {
  const started = Date.now(), prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8')); prepared.inputs.forEach(check); assert.equal(sha(process.execPath), prepared.node.sha256); assert(!fs.existsSync(resultPath), 'CSS_RESULT_EXISTS');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'alarm-review-css-')); assert(!/[^\x20-\x7e]/.test(directory));
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, scope: 'alarm-review-css-probe', directory: fs.realpathSync(directory) }));
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  const record = { status: 'loader-not-completed', pid: process.pid, ownedDirectory: directory, prepared: binding(preparedPath), priorFailure: binding(failedPath), policy: { networkRejected: 0, writesRejected: 0 }, errors: [], warnings: [], phases: {}, stage: 'early-isolation', sourcesAfterUnchanged: false, cleanup: { directoryRemoved: false } };
  const knownPath = file => { if (typeof file !== 'string') return undefined; const relative = path.relative(root, path.resolve(file)); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) ? relative.replace(/\\/g, '/') : '<outside-project>'; };
  const cleanText = value => String(value || '').split(/\r?\n/)[0].replaceAll(root, '<project>').replaceAll(directory, '<owned-temp>').replace(/[A-Za-z]:[\\/][^\s"')]+/g, '<absolute-path>').replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/(?:Bearer\s+\S+|(?:token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+)/gi, '<redacted>').slice(0, 400);
  function safeError(error) { const original = error?.cause && typeof error.cause === 'object' ? error.cause : error; return { stage: record.stage, name: cleanText(original?.name), code: /^[A-Z0-9_]{1,80}$/.test(original?.code || '') ? original.code : undefined, plugin: cleanText(original?.plugin), reason: cleanText(original?.reason || original?.message), file: knownPath(original?.file), line: Number.isFinite(original?.line) ? original.line : undefined, column: Number.isFinite(original?.column) ? original.column : undefined, frames: String(original?.stack || '').split(/\r?\n/).slice(1).filter(line => line.includes(root)).slice(0, 3).map(cleanText) }; }
  const timer = setTimeout(() => { record.softBudgetExceeded = true; stdout('CSS_PROBE_OVER_30S_STILL_WAITING_NO_FORCE_KILL\n'); }, 30000); timer.unref();
  try {
    installIsolation(directory, record);
    process.stdout.write = () => true; process.stderr.write = () => true;
    const utils = require('postcss-loader/dist/utils');
    const loadConfig = utils.loadConfig, getOptions = utils.getPostcssOptions;
    utils.loadConfig = async function (...args) { record.stage = 'config-search'; const time = Date.now(); try { const result = await loadConfig.apply(this, args); record.loadedConfig = knownPath(result?.filepath); record.configPluginNames = Object.keys(result?.config?.plugins || {}); return result; } finally { record.phases.configSearchMs = Date.now() - time; } };
    utils.getPostcssOptions = async function (...args) { record.stage = 'plugin-resolution'; const time = Date.now(); try { const result = await getOptions.apply(this, args); record.effectivePlugins = result.plugins.map(plugin => cleanText(plugin.postcssPlugin || plugin.name || '<unnamed>')); record.processPaths = { from: knownPath(result.processOptions.from), to: knownPath(result.processOptions.to) }; record.stage = 'css-processing'; return result; } finally { record.phases.pluginResolutionMs = Date.now() - time; } };
    const dependencies = new Set(), source = path.join(root, 'client/src/index.css');
    const loaderStart = Date.now();
    await new Promise((resolve, reject) => {
      const context = new Proxy({ resource: source, resourcePath: source, context: path.dirname(source), rootContext: root, mode: 'development', fs, sourceMap: false,
        getOptions: () => ({ postcssOptions: { plugins: { 'postcss-import': { resolve: createInspectorResolver(true) }, '@tailwindcss/postcss': {} } } }),
        async: () => (error, css) => { if (error) reject(error); else { record.cssOutput = { bytes: Buffer.byteLength(css), sha256: crypto.createHash('sha256').update(css).digest('hex') }; resolve(); } },
        emitError: error => record.errors.push(safeError(error)), emitWarning: error => record.warnings.push(safeError(error)),
        addDependency: file => dependencies.add(file), addBuildDependency: file => dependencies.add(file), addMissingDependency: file => dependencies.add(file), addContextDependency: file => dependencies.add(file),
        emitFile: () => { throw Object.assign(new Error('CSS_ASSET_EMISSION_NOT_ALLOWED'), { code: 'CSS_ASSET_EMISSION_NOT_ALLOWED' }); },
      }, { get: (target, key) => { if (!(key in target)) throw Object.assign(new Error('UNKNOWN_LOADER_CONTEXT_MEMBER'), { code: 'UNKNOWN_LOADER_CONTEXT_MEMBER' }); return target[key]; } });
      const loader = require('postcss-loader');
      assert.equal(typeof loader, 'function', 'POSTCSS_PUBLIC_LOADER_NOT_CALLABLE');
      Promise.resolve(loader.call(context, fs.readFileSync(source, 'utf8'))).catch(reject);
    }).finally(() => { record.phases.loaderMs = Date.now() - loaderStart; record.dependencies = [...dependencies].filter(file => fs.existsSync(file) && fs.statSync(file).isFile()).map(file => ({ file: knownPath(file), sha256: sha(file) })).slice(0, 100); });
    record.status = record.errors.length ? 'loader-emitted-error' : 'loader-success-not-full-entry';
  } catch (error) { record.status = 'loader-failed'; record.errors.push(safeError(error)); }
  finally {
    clearTimeout(timer); process.stdout.write = stdout; process.stderr.write = stderr;
    try { record.sourcesAfterUnchanged = prepared.inputs.every(item => sha(path.resolve(root, item.file)) === item.sha256); } catch (error) { record.errors.push(safeError(error)); }
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); assert.equal(marker.pid, process.pid); assert.equal(marker.scope, 'alarm-review-css-probe'); assert.equal(marker.directory, fs.realpathSync(directory));
      function remove(folder) { assert(!fs.lstatSync(folder).isSymbolicLink()); for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); assert(!fs.lstatSync(file).isSymbolicLink()); if (folder === directory) {
          if (entry.name === 'jiti') { assert(entry.isDirectory(), 'JITI_NOT_DIRECTORY'); assert.equal(fs.readdirSync(file).length, 0, 'NONEMPTY_JITI_NO_DELETE'); fs.rmdirSync(file); continue; }
          assert.equal(entry.name, 'owner.json', 'UNKNOWN_CSS_PROBE_ROOT_FILE_NO_DELETE');
        } if (entry.isDirectory()) remove(file); else fs.unlinkSync(file); } fs.rmdirSync(folder); }
      remove(directory); record.cleanup.directoryRemoved = true;
    } catch (error) { record.cleanup.retainedDirectory = directory; record.cleanup.error = safeError(error); }
    record.elapsedMs = Date.now() - started; record.completedAt = new Date().toISOString();
    record.diagnosticOnly = true; record.applicationOrBrowserStarted = false; record.networkAllowed = false;
    fs.writeFileSync(resultPath, JSON.stringify(record, null, 2)); stdout(JSON.stringify({ status: record.status, result: path.relative(root, resultPath), sha256: sha(resultPath), elapsedMs: record.elapsedMs }) + '\n');
    if (record.errors.length || !record.sourcesAfterUnchanged || !record.cleanup.directoryRemoved || record.policy.networkRejected || record.policy.writesRejected) process.exitCode = 1;
  }
}
async function checkResolverContract() {
  const began = Date.now(), prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8')); prepared.inputs.forEach(check);
  assert.equal(sha(process.execPath), prepared.node.sha256);
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'alarm-review-css-contract-'));
  assert(!/[^\x20-\x7e]/.test(directory));
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, scope: 'alarm-review-css-contract', directory: fs.realpathSync(directory) }));
  const record = { policy: { networkRejected: 0, writesRejected: 0 } }; let passed = false;
  try {
    installIsolation(directory, record);
    const exported = require('postcss-loader');
    const requireCallable = value => assert.equal(typeof value, 'function', 'POSTCSS_PUBLIC_LOADER_NOT_CALLABLE');
    requireCallable(exported);
    verifyPresetDigest(sha(presetPath));
    assert.throws(() => verifyPresetDigest('0'.repeat(64)), /PRODUCTION_CSS_RESOLVER_DRIFT/);
    const basedir = path.join(root, 'node_modules/@lark-apaas/client-toolkit/lib');
    for (const isDev of [true, false]) {
      const resolve = createInspectorResolver(isDev);
      for (const id of ['@/inspector.dev.css', 'tailwindcss', './local.css']) validateResolution(isDev, id, basedir, resolve(id, basedir));
    }
    assert.throws(() => validateResolution(true, '@/inspector.dev.css', basedir, []), /INVALID_INSPECTOR_RESOLUTION/);
    assert.throws(() => validateResolution(false, '@/inspector.dev.css', basedir, path.join(basedir, 'inspector.dev.css')), /INVALID_INSPECTOR_RESOLUTION/);
    assert.throws(() => validateResolution(true, 'tailwindcss', basedir, 'replaced.css'), /INVALID_INSPECTOR_RESOLUTION/);
    assert.throws(() => createInspectorResolver(undefined), /EXPLICIT_CSS_MODE_REQUIRED/);
    assert.throws(() => requireCallable(exported.default), /POSTCSS_PUBLIC_LOADER_NOT_CALLABLE/);
    assert.equal(record.policy.networkRejected, 0); assert.equal(record.policy.writesRejected, 0);
    prepared.inputs.forEach(check); passed = true;
  } finally {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    assert.equal(marker.pid, process.pid); assert.equal(marker.scope, 'alarm-review-css-contract'); assert.equal(marker.directory, fs.realpathSync(directory));
    assert.deepEqual(fs.readdirSync(directory), ['owner.json']);
    fs.unlinkSync(path.join(directory, 'owner.json')); fs.rmdirSync(directory);
    process.stdout.write(JSON.stringify({ contract: passed ? 'passed' : 'failed', positive: 'public loader; dev SDK basedir; prod []; other ids unchanged', negative: 'undefined default; invalid resolution/mode; preset drift rejected', cssExecuted: false, preparedSha256: sha(preparedPath), pid: process.pid, directory, directoryRemoved: !fs.existsSync(directory), policy: record.policy, elapsedMs: Date.now() - began }) + '\n');
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--check-resolver-contract')) checkResolverContract().catch(() => { process.stderr.write('CSS_RESOLVER_CONTRACT_FAILED\n'); process.exitCode = 1; });
else if (process.argv.includes('--approved-css-probe')) probe().catch(() => { process.stderr.write('CSS_PROBE_PRECONDITION_FAILED_NO_RETRY\n'); process.exitCode = 1; });
else throw new Error('EXPLICIT_PREPARE_OR_SEPARATE_CSS_PROBE_APPROVAL_REQUIRED');
