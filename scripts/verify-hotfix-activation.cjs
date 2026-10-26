const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function check(condition, reason) { if (!condition) throw Error(reason); }
function controlled(file, maximum = 4 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum && samePath(fs.realpathSync(file), file), 'HOTFIX_ACTIVATION_UNSAFE_FILE');
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  check(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs &&
    after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && bytes.length === before.size && samePath(fs.realpathSync(file), file), 'HOTFIX_ACTIVATION_FILE_CHANGED');
  return bytes;
}
const readJson = file => JSON.parse(controlled(file).toString('utf8').replace(/^\uFEFF/, ''));
function rootPath(root) {
  check(typeof root === 'string' && path.isAbsolute(root), 'HOTFIX_ACTIVATION_INVALID_ROOT');
  const value = path.resolve(root), stat = fs.lstatSync(value);
  check(stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync(value), value), 'HOTFIX_ACTIVATION_INVALID_ROOT');
  return value;
}
function verified(file, expected) {
  const bytes = controlled(file);
  check(expected && expected.size === bytes.length && /^[a-f0-9]{64}$/.test(expected.sha256) && digest(bytes) === expected.sha256, 'HOTFIX_ACTIVATION_FILE_MISMATCH');
  return file;
}
function uniqueEntry(entries, key, value) {
  check(Array.isArray(entries), 'HOTFIX_ACTIVATION_INVALID_MANIFEST');
  const found = entries.filter(item => item && item[key] === value);
  check(found.length === 1, 'HOTFIX_ACTIVATION_INVALID_MANIFEST');
  return found[0];
}
function tlsOptions(appRoot, manifest) {
  const name = 'dist/server/runtime-env.js', entry = uniqueEntry(manifest.payloadFiles, 'path', name);
  require(verified(path.join(appRoot, name), entry));
  check(process.env.HTTPS_CERT_PATH?.trim(), 'HOTFIX_ACTIVATION_TLS_CONFIGURATION');
  const cert = controlled(path.resolve(appRoot, process.env.HTTPS_CERT_PATH)), pin = digest(new X509Certificate(cert).raw);
  const ca = [cert];
  if (process.env.HTTPS_CA_PATH?.trim()) ca.push(controlled(path.resolve(appRoot, process.env.HTTPS_CA_PATH)));
  return { rejectUnauthorized: true, ca, servername: '', checkServerIdentity: (_host, peer) =>
    peer.raw && digest(peer.raw) === pin ? undefined : Error('HOTFIX_ACTIVATION_TLS_PEER_MISMATCH') };
}
function health(url, tls, timeout) {
  return new Promise((done, fail) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, { ...tls, agent: false, timeout }, response => {
      const chunks = []; let size = 0;
      response.on('data', bytes => {
        size += bytes.length;
        if (size > 64 * 1024) { response.destroy(Error('HOTFIX_ACTIVATION_RESPONSE_TOO_LARGE')); return; }
        chunks.push(bytes);
      });
      response.on('error', fail);
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(Error('HOTFIX_ACTIVATION_REQUEST_TIMEOUT')));
    request.on('error', fail);
  });
}
function isActive(response, deploymentId) {
  const phase = response.headers['x-nantong-hotfix-activation'];
  check(response.headers['x-nantong-hotfix-deployment'] === deploymentId && ['waiting', 'initializing', 'active', 'failed', 'closed'].includes(phase), 'HOTFIX_ACTIVATION_WRONG_PROCESS');
  check(phase !== 'failed' && phase !== 'closed', 'HOTFIX_ACTIVATION_FAILED');
  return response.status === 200 && phase === 'active' && response.headers['x-nantong-hotfix-accepting'] === 'true';
}
async function verifyHotfixActivation({ appRoot: root, packageRoot: packageInput, healthEndpoint, timeoutMs = 120_000 }) {
  const started = Date.now(), appRoot = rootPath(root), packageRoot = rootPath(packageInput);
  check(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120_000, 'HOTFIX_ACTIVATION_INVALID_TIMEOUT');
  const manifestPath = path.join(packageRoot, 'hotfix-manifest.json'), manifestBytes = controlled(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  check(manifest.schemaVersion === 6 && manifest.releaseMode === 'complete-runtime-atomic-switch' &&
    /^nantong-safe-full-runtime-hotfix-\d{8}-\d{6,9}$/.test(manifest.packageId), 'HOTFIX_ACTIVATION_INVALID_MANIFEST');
  check(manifest.buildNodeVersion === process.versions.node && manifest.buildNodeSha256 === digest(controlled(process.execPath, 128 * 1024 * 1024)), 'HOTFIX_ACTIVATION_NODE_MISMATCH');
  const verifierName = 'scripts/verify-hotfix-activation.cjs', own = uniqueEntry(manifest.releaseFiles, 'targetPath', verifierName);
  check(own.path === 'release-root/' + verifierName, 'HOTFIX_ACTIVATION_INVALID_MANIFEST');
  verified(__filename, own); verified(path.join(appRoot, verifierName), own);
  const policyName = 'dist/server/common/hotfix-release-proof.js';
  const policy = uniqueEntry(manifest.payloadFiles, 'path', policyName);
  verified(path.join(appRoot, policyName), policy);
  const { inspectHotfixReleaseProof } = require(verified(path.join(packageRoot, policyName), policy));
  const receiptPath = path.join(appRoot, '.hotfix-installed-release.json'), journalPath = path.join(appRoot, '.hotfix-transaction.json');
  const proof = inspectHotfixReleaseProof(appRoot), receipt = readJson(receiptPath), journal = readJson(journalPath);
  check(proof.mode === 'installed' && proof.canAcceptNewWork && !proof.maintenance && proof.deploymentId === manifest.packageId &&
    journal.phase === 'finalized' && journal.deploymentId === manifest.packageId, 'HOTFIX_ACTIVATION_NOT_FINALIZED');
  for (const key of ['buildFingerprint', 'runtimeClosureFingerprint', 'activeClientAssetFingerprint']) {
    check(/^[a-f0-9]{64}$/.test(manifest[key]) && receipt[key] === manifest[key], 'HOTFIX_ACTIVATION_RECEIPT_MISMATCH');
  }
  for (const name of ['dist/server/main.js', 'dist/server/hotfix-runtime-identity.json']) {
    verified(path.join(appRoot, name), uniqueEntry(manifest.payloadFiles, 'path', name));
  }
  const pidPath = path.join(appRoot, 'app.pid'), pidBytes = controlled(pidPath), pid = JSON.parse(pidBytes.toString('utf8').replace(/^\uFEFF/, ''));
  check(pid.schemaVersion === 1 && Number.isSafeInteger(pid.pid) && pid.pid > 0 && Number.isFinite(Date.parse(pid.startTime)) &&
    typeof pid.appRoot === 'string' && samePath(pid.appRoot, appRoot) && typeof pid.mainFile === 'string' && samePath(pid.mainFile, path.join(appRoot, 'dist/server/main.js')), 'HOTFIX_ACTIVATION_PID_MISMATCH');
  process.kill(pid.pid, 0);
  const endpoint = new URL(healthEndpoint ?? manifest.healthEndpoint);
  check(['http:', 'https:'].includes(endpoint.protocol) && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname) &&
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname.endsWith('/api/access/session'), 'HOTFIX_ACTIVATION_INVALID_HEALTH_URL');
  const callback = new URL(endpoint); callback.pathname = endpoint.pathname.slice(0, -'/access/session'.length) + '/feishu-card-callback/health';
  const tls = endpoint.protocol === 'https:' ? tlsOptions(appRoot, manifest) : {};
  while (Date.now() - started < timeoutMs) {
    try {
      const access = await health(endpoint, tls, Math.max(1, Math.min(1500, timeoutMs - (Date.now() - started))));
      if (isActive(access, manifest.packageId)) {
        const body = JSON.parse(access.body);
        if (body.role != null && body.capabilities != null) {
          const response = await health(callback, tls, Math.max(1, Math.min(1500, timeoutMs - (Date.now() - started))));
          if (isActive(response, manifest.packageId)) {
            const transport = JSON.parse(response.body);
            if (typeof transport.enabled === 'boolean' && typeof transport.ready === 'boolean' && (!transport.enabled || transport.ready)) {
              check(controlled(pidPath).equals(pidBytes) && controlled(manifestPath).equals(manifestBytes), 'HOTFIX_ACTIVATION_FILE_CHANGED');
              const current = inspectHotfixReleaseProof(appRoot);
              check(current.mode === 'installed' && current.canAcceptNewWork && current.deploymentId === manifest.packageId, 'HOTFIX_ACTIVATION_NOT_FINALIZED');
              process.kill(pid.pid, 0);
              return { deploymentId: manifest.packageId, phase: 'active', pid: pid.pid, elapsedMs: Date.now() - started };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && /^HOTFIX_ACTIVATION_/.test(error.message) && error.message !== 'HOTFIX_ACTIVATION_REQUEST_TIMEOUT') throw error;
      if (endpoint.protocol === 'https:' && error?.code && /CERT|TLS|SSL/.test(error.code)) throw Error('HOTFIX_ACTIVATION_TLS_FAILED');
    }
    await new Promise(done => setTimeout(done, Math.min(100, Math.max(0, timeoutMs - (Date.now() - started)))));
  }
  throw Error('HOTFIX_ACTIVATION_TIMEOUT');
}
module.exports = { verifyHotfixActivation };
if (require.main === module) {
  void (async () => {
    const args = process.argv.slice(2), values = {};
    check(args.length % 2 === 0, 'HOTFIX_ACTIVATION_INVALID_ARGUMENTS');
    for (let i = 0; i < args.length; i += 2) {
      check(['--app-root', '--package-root', '--health-endpoint', '--timeout-ms'].includes(args[i]) && values[args[i]] === undefined, 'HOTFIX_ACTIVATION_INVALID_ARGUMENTS');
      values[args[i]] = args[i + 1];
    }
    const result = await verifyHotfixActivation({ appRoot: values['--app-root'], packageRoot: values['--package-root'],
      healthEndpoint: values['--health-endpoint'], ...(values['--timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['--timeout-ms']) }) });
    console.log(JSON.stringify(result));
  })().catch(error => {
    console.error(error instanceof Error && /^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : 'HOTFIX_ACTIVATION_PROOF_FAILED');
    process.exitCode = 1;
  });
}
