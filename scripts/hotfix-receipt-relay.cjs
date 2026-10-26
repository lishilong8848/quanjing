'use strict';
// This helper handles metadata only. It never starts/stops the application or walks dist/node_modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const MAX_BYTES = 4 * 1024 * 1024;
const PRODUCTION_ROOT = 'C:\\ai\\nantong-schedule-20260428-101724';
const PREFIX = 'nantong-release-receipts/v1';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^nantong-safe-full-runtime-hotfix-\d{8}-\d{6,9}$/;
const RECEIPT_FIELDS = ['schemaVersion', 'receiptType', 'deploymentId', 'appRoot',
  'releaseToolFingerprint', 'installerSha256', 'recoveryLauncherSha256', 'dependencyVerifierSha256',
  'clientVerifierSha256', 'dependencyProofAlgorithm', 'dependencyLockPhysicalTreeFingerprint',
  'dependencyInstalledPhysicalTreeFingerprint', 'dependencyPackageCount', 'dependencyFileCount',
  'dependencyBytes', 'buildFingerprint', 'runtimeClosureFingerprint', 'activeClientProofAlgorithm',
  'activeClientAssetFingerprint', 'activeClientChunkCount', 'activeClientAssetCount',
  'runtimeFiles', 'activeClientFiles', 'releaseFiles'];
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = value => JSON.parse(String(value).replace(/^\uFEFF/, ''));
const sameRoot = (a, b) => path.win32.normalize(a).replace(/\\$/, '').toLowerCase() === path.win32.normalize(b).replace(/\\$/, '').toLowerCase();
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));
// Match Windows PowerShell ConvertTo-Json escaping, including historical apostrophes.
const psJson = obj => JSON.stringify(obj).replace(/'/g, '\\u0027').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
function receiptPayload(r) {
  const p = pick(r, RECEIPT_FIELDS);
  for (const key of ['runtimeFiles', 'activeClientFiles']) p[key] = r[key].map(f => pick(f, ['path', 'size', 'sha256']));
  p.releaseFiles = r.releaseFiles.map(f => pick(f, ['targetPath', 'size', 'sha256']));
  return p;
}
function receiptChecksum(r) { return hash(psJson(receiptPayload(r))); }
function journalChecksum(j) {
  const p = pick(j, ['schemaVersion', 'transactionId', 'deploymentId', 'appRoot', 'intent', 'phase']);
  p.releaseFiles = j.releaseFiles.map(f => pick(f, ['targetPath', 'baselineExisted', 'baselineSha256', 'candidateSha256']));
  return hash(psJson(p));
}
function entries(list, key, allowed) {
  assert(Array.isArray(list) && list.length > 0 && list.length < 10000, 'invalid-file-list');
  const seen = new Set();
  return list.map(f => {
    const name = f[key];
    assert(typeof name === 'string' && /^[\w./-]+$/.test(name) && !name.split('/').some(x => x === '..' || x === '.' || !x), 'unsafe-entry-path');
    assert(!seen.has(name.toLowerCase()) && allowed(name), 'duplicate-or-out-of-scope-entry');
    seen.add(name.toLowerCase());
    assert(Number.isSafeInteger(f.size) && f.size >= 0 && HASH.test(f.sha256), 'invalid-entry-hash');
    return [name, f.size, f.sha256];
  }).sort((a, b) => a[0].localeCompare(b[0], 'en'));
}
function validateEvidence(e, registration) {
  const r = e.receipt, j = e.journal, m = registration.manifest;
  assert(e.schemaVersion === 1 && r?.schemaVersion === 2 && r.receiptType === 'nantong-hotfix-installed-release', 'unsupported-receipt');
  assert(ID.test(r.deploymentId) && r.deploymentId === m.packageId, 'package-id-mismatch');
  assert(sameRoot(r.appRoot, registration.expectedRoot) && sameRoot(j.appRoot, registration.expectedRoot), 'production-root-mismatch');
  assert(HASH.test(e.innerSha256) && e.innerSha256 === registration.innerSha256, 'package-hash-mismatch');
  assert(Object.keys(r).sort().join('|') === [...RECEIPT_FIELDS, 'receiptChecksum'].sort().join('|'), 'unexpected-receipt-fields');
  assert(HASH.test(r.receiptChecksum) && receiptChecksum(r) === r.receiptChecksum, 'receipt-checksum-mismatch');
  assert(j.schemaVersion === 1 && j.intent === 'deploy' && j.phase === 'finalized' && j.deploymentId === r.deploymentId, 'transaction-not-finalized');
  assert(Object.keys(j).sort().join('|') === ['schemaVersion', 'transactionId', 'deploymentId', 'appRoot', 'intent', 'phase', 'releaseFiles', 'transactionChecksum'].sort().join('|'), 'unexpected-journal-fields');
  assert(HASH.test(j.transactionChecksum) && journalChecksum(j) === j.transactionChecksum, 'journal-checksum-mismatch');
  for (const key of RECEIPT_FIELDS.slice(4, -3)) assert(m[key] === r[key], `manifest-${key}-mismatch`);
  const strict = name => name.startsWith('dist/server/') || name.startsWith('dist/shared/');
  const match = (actual, expected, key, allow) => assert(JSON.stringify(entries(actual, key, allow)) === JSON.stringify(entries(expected, key, allow)), 'manifest-files-mismatch');
  match(r.runtimeFiles, m.payloadFiles.filter(f => strict(f.path)), 'path', strict);
  match(r.activeClientFiles, m.activeClientFiles, 'path', name => name.startsWith('dist/client/'));
  match(r.releaseFiles, m.releaseFiles, 'targetPath', name => !name.startsWith('dist/'));
  const journalRoots = j.releaseFiles.map(f => [f.targetPath, f.candidateSha256]).sort();
  assert(JSON.stringify(journalRoots) === JSON.stringify(r.releaseFiles.map(f => [f.targetPath, f.sha256]).sort()), 'journal-roots-mismatch');
  assert(Number.isFinite(Date.parse(e.completedAt)) && Date.parse(e.completedAt) <= Date.now() + 300000, 'invalid-completion-time');
  return r;
}
function seal(e, secret) {
  const iv = crypto.randomBytes(12);
  const key = crypto.hkdfSync('sha256', secret, 'nantong-release-relay', 'receipt-encryption-v1', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(e)));
  cipher.setAAD(Buffer.from(PREFIX));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
}
function open(text, secret) {
  assert(Buffer.byteLength(text) < MAX_BYTES, 'oversized-envelope');
  const data = parse(text);
  assert(data.version === 1, 'unsupported-envelope');
  const key = crypto.hkdfSync('sha256', secret, 'nantong-release-relay', 'receipt-encryption-v1', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAAD(Buffer.from(PREFIX)); decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  const bytes = Buffer.concat([decipher.update(Buffer.from(data.body, 'base64')), decipher.final()]);
  return parse(zlib.gunzipSync(bytes, { maxOutputLength: MAX_BYTES }));
}
function safePath(file) {
  const full = path.resolve(file);
  assert(!full.slice(path.parse(full).root.length).includes(':'), 'alternate-stream-rejected');
  let current = full;
  while (true) {
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'linked-path-rejected');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return full;
}
function read(file, limit = MAX_BYTES) {
  safePath(file); const stat = fs.statSync(file);
  assert(stat.isFile() && stat.size <= limit, 'invalid-metadata-file');
  return fs.readFileSync(file, 'utf8');
}
function atomic(file, value) {
  safePath(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
async function deadline(promise, milliseconds = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('network-deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function withLock(root, fn) {
  safePath(root); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'relay.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = parse(read(file));
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    assert(!alive, 'relay-busy');
    fs.unlinkSync(file); fd = fs.openSync(file, 'wx', 0o600);
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  return Promise.resolve().then(fn).finally(() => fs.unlinkSync(file));
}
function config(appRoot) {
  const req = createRequire(path.join(path.resolve(appRoot), 'package.json'));
  const env = { ...process.env };
  const dotenv = req('dotenv');
  for (const name of [path.join(path.dirname(appRoot), 'nantong-schedule.private.env'), path.join(appRoot, '.env'), path.join(appRoot, '.env.local')]) {
    if (fs.existsSync(name)) {
      const values = dotenv.parse(read(name));
      for (const [key, value] of Object.entries(values)) if (value.trim()) env[key] = value;
    }
  }
  assert(!/^(1|true)$/i.test(env.NANTONG_HOTFIX_SMOKE_MODE || ''), 'smoke-publishing-disabled');
  const secret = env.COS_SECRET_KEY || env.TENCENTCLOUD_SECRET_KEY;
  const id = env.COS_SECRET_ID || env.TENCENTCLOUD_SECRET_ID;
  assert(secret && id, 'cos-credentials-unavailable');
  const COS = req('cos-nodejs-sdk-v5');
  return { secret, cos: new COS({ SecretId: id, SecretKey: secret,
    SecurityToken: env.COS_SESSION_TOKEN || env.TENCENTCLOUD_SESSION_TOKEN || undefined,
    Timeout: 5000, FileParallelLimit: 1 }),
    Bucket: env.COS_BUCKET || 'jy-1421907124', Region: env.COS_REGION || 'ap-shanghai' };
}
function objectKey(root, id, sha) {
  assert(ID.test(id) && HASH.test(sha), 'invalid-object-key');
  return `${PREFIX}/${hash(path.win32.normalize(root).toLowerCase()).slice(0, 24)}/${id}-${sha}.json`;
}
async function probeStorage(cfg) {
  const canary = { canary: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const params = { Bucket: cfg.Bucket, Region: cfg.Region, Key: `${PREFIX}/canary/${canary.canary}.json` };
  let uploaded = false;
  try {
    try { await deadline(cfg.cos.putObject({ ...params, Body: seal(canary, cfg.secret), ACL: 'private', ContentType: 'application/json' })); uploaded = true; }
    catch (error) { error.message = 'canary-upload-failed'; throw error; }
    let response;
    try { response = await deadline(cfg.cos.getObject(params)); }
    catch (error) { const safe = new Error('canary-read-failed'); safe.code = error.code; safe.statusCode = error.statusCode; throw safe; }
    assert(open(String(response.Body), cfg.secret).canary === canary.canary, 'canary-readback-mismatch');
  } finally {
    // Only this run's random canary key is removed; no production receipt or business object is touched.
    if (uploaded) {
      try { await deadline(cfg.cos.deleteObject(params)); }
      catch (error) { error.message = 'canary-cleanup-failed'; throw error; }
    }
  }
  return { status: 'storage-verified', canaryRemoved: true };
}
async function publish(appRoot) {
  assert(sameRoot(appRoot, PRODUCTION_ROOT), 'production-root-mismatch');
  const root = path.join(appRoot, '.hotfix-receipt-relay');
  return withLock(root, async () => {
    const pending = path.join(root, 'pending');
    const names = fs.existsSync(pending) ? fs.readdirSync(pending).filter(n => ID.test(n.replace(/\.json$/, ''))).sort().reverse() : [];
    if (!names.length) return { status: 'idle' };
    const cfg = config(appRoot);
    // One job per bounded run. Each deployment has an immutable key; late retries cannot replace a newer version.
    const name = names[0], jobPath = path.join(pending, name), job = parse(read(jobPath));
    validateEvidence(job, { expectedRoot: PRODUCTION_ROOT, innerSha256: job.innerSha256, manifest: job.manifest });
    const envelope = pick(job, ['schemaVersion', 'innerSha256', 'receipt', 'journal', 'completedAt']);
    const body = seal(envelope, cfg.secret);
    const params = { Bucket: cfg.Bucket, Region: cfg.Region, Key: objectKey(PRODUCTION_ROOT, job.receipt.deploymentId, job.innerSha256) };
    await deadline(cfg.cos.putObject({ ...params, Body: body, ACL: 'private', ContentType: 'application/json' }));
    const remote = await deadline(cfg.cos.getObject(params));
    const restored = open(String(remote.Body), cfg.secret);
    validateEvidence(restored, { expectedRoot: PRODUCTION_ROOT, innerSha256: job.innerSha256, manifest: job.manifest });
    atomic(path.join(root, 'sent', name), { deploymentId: job.receipt.deploymentId, receiptChecksum: job.receipt.receiptChecksum, uploadedAt: new Date().toISOString() });
    fs.unlinkSync(jobPath);
    return { status: 'uploaded', deploymentId: job.receipt.deploymentId, bytes: Buffer.byteLength(body) };
  });
}
function registrationDecision(production, event) {
  const id = event.receipt.deploymentId;
  if (production.deploymentId === id) { assert(production.innerSha256 === event.innerSha256, 'same-id-different-package'); return 'same'; }
  assert(ID.test(production.deploymentId) && ID.test(id), 'unrecognized-version-order');
  return id < production.deploymentId ? 'older' : 'new';
}
async function syncWorkspace(workspace, options = {}) {
  const dir = path.join(workspace, '.release-receipts'), registryPath = path.join(dir, 'pending.json');
  if (!fs.existsSync(registryPath)) return { status: 'idle' };
  return withLock(dir, async () => {
    const registry = parse(read(registryPath));
    if (!registry.length) return { status: 'idle' };
    const cfg = options.transport || config(workspace);
    const entry = registry.at(-1);
    const params = { Bucket: cfg.Bucket, Region: cfg.Region, Key: objectKey(entry.expectedRoot, entry.manifest.packageId, entry.innerSha256) };
    let remote;
    try { remote = await deadline(cfg.cos.getObject(params)); }
    catch (error) { if (error.statusCode === 404) return { status: 'waiting', deploymentId: entry.manifest.packageId }; throw error; }
    const event = open(String(remote.Body), cfg.secret);
    const receipt = validateEvidence(event, entry);
    const ledgerPath = path.join(workspace, 'docs/engineering/production-release-state.json');
    const ledger = parse(read(ledgerPath));
    const decision = registrationDecision(ledger.production, event);
    atomic(path.join(dir, 'received', `${receipt.deploymentId}.json`), event);
    if (decision !== 'older') {
      ledger.updatedAt = new Date().toISOString();
      ledger.production = { ...ledger.production, status: 'receipt-confirmed-healthy',
        applicationRoot: entry.expectedRoot, deploymentId: receipt.deploymentId,
        outerPackage: entry.outerPackage, outerSha256: entry.outerSha256, innerSha256: entry.innerSha256,
        serverReceipt: { path: '.hotfix-installed-release.json', schemaVersion: 2, copiedToLocalWorkspace: true,
          localCopy: `.release-receipts/received/${receipt.deploymentId}.json`, receiptChecksum: receipt.receiptChecksum,
          evidence: 'Authenticated encrypted production receipt and finalized journal matched the locally registered verified package. This is installation evidence, not validation of every business workflow.' } };
      atomic(ledgerPath, ledger);
    }
    atomic(registryPath, registry.filter(e => e.manifest.packageId !== receipt.deploymentId));
    return { status: decision === 'older' ? 'ignored-older' : 'registered', deploymentId: receipt.deploymentId };
  });
}
function zipEntry(bytes, name, max = MAX_BYTES) {
  const { unzipSync } = require('fflate');
  let matches = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (entry.name.replaceAll('\\', '/') !== name) return false;
    matches++;
    assert(entry.originalSize <= max, 'oversized-zip-entry');
    return true;
  } });
  const keys = Object.keys(files);
  assert(matches === 1 && keys.length === 1, 'zip-entry-missing-or-ambiguous');
  return Buffer.from(files[keys[0]]);
}
async function registerPackage(workspace, outerPath) {
  assert(fs.statSync(safePath(outerPath)).size < 100 * 1024 * 1024, 'oversized-package');
  const bytes = fs.readFileSync(outerPath), outerSha256 = hash(bytes);
  assert(read(`${outerPath}.sha256`).trim().split(/\s/)[0].toLowerCase() === outerSha256, 'outer-hash-mismatch');
  const inner = zipEntry(bytes, '_hotfix-payload/hotfix-package.zip', 80 * 1024 * 1024);
  const innerSha256 = hash(inner);
  assert(zipEntry(bytes, '_hotfix-payload/hotfix-package.zip.sha256').toString().trim().split(/\s/)[0].toLowerCase() === innerSha256, 'inner-hash-mismatch');
  const manifest = parse(zipEntry(inner, 'hotfix-manifest.json'));
  assert(ID.test(manifest.packageId), 'invalid-manifest-id');
  const ledger = parse(read(path.join(workspace, 'docs/engineering/production-release-state.json')));
  const entry = { expectedRoot: ledger.production.applicationRoot, outerPackage: path.basename(outerPath), outerSha256, innerSha256, manifest };
  const dir = path.join(workspace, '.release-receipts');
  return withLock(dir, async () => {
    const file = path.join(dir, 'pending.json');
    const pending = fs.existsSync(file) ? parse(read(file)) : [];
    const previous = pending.find(x => x.manifest.packageId === manifest.packageId);
    if (previous) assert(previous.innerSha256 === innerSha256 && previous.outerSha256 === outerSha256, 'registered-id-collision');
    else { pending.push(entry); atomic(file, pending); }
    return { status: 'awaiting-server-receipt', deploymentId: manifest.packageId };
  });
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const arg = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
  const root = path.resolve(arg('workspace') || arg('app-root') || process.cwd());
  // Hard outer deadline also ends stuck SDK retries/sockets; pending files remain intact.
  const guard = setTimeout(() => { process.stderr.write('receipt-relay: operation-deadline; pending retained\n'); process.exit(2); }, 25000);
  try {
    let result;
    if (command === 'sync') result = await syncWorkspace(root);
    else if (command === 'publish') result = await publish(root);
    else if (command === 'probe') result = await probeStorage(config(root));
    else if (command === 'register') { assert(arg('outer'), 'missing-outer'); result = await registerPackage(root, path.resolve(arg('outer'))); }
    else throw new Error('usage: sync --workspace ROOT | publish --app-root ROOT | register --workspace ROOT --outer ZIP');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // SDK errors can contain authorization headers and signed URLs. Never log raw messages/stacks.
    const safe = /^[a-z][a-z0-9-]{1,90}$/.test(error.message) ? error.message : 'operation-failed';
    const safeCode = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(String(error.code)) ? String(error.code) : '';
    const safeStatus = Number.isInteger(error.statusCode) ? String(error.statusCode) : '';
    process.stderr.write(`receipt-relay: ${safe}; code=${safeCode}; status=${safeStatus}; pending retained\n`); process.exitCode = 2;
  } finally { guard.unref(); }
}
module.exports = { receiptChecksum, journalChecksum, validateEvidence, seal, open, deadline, registrationDecision, syncWorkspace, registerPackage, publish, probeStorage, atomic, safePath };
if (require.main === module) main();
