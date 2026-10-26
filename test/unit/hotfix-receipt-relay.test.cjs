const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const file = path.resolve(__dirname, '../../scripts/hotfix-receipt-relay.cjs');
test('receipt relay implementation exists', () => assert.ok(fs.existsSync(file)));
const relay = fs.existsSync(file) ? require(file) : null;
const run = (name, fn) => test(name, { skip: !relay }, fn);
const root = 'C:\\ai\\nantong-schedule-20260428-101724';
const sha = 'a'.repeat(64);
function fixture() {
  const receipt = { schemaVersion: 2, receiptType: 'nantong-hotfix-installed-release',
    deploymentId: 'nantong-safe-full-runtime-hotfix-20260908-131146', appRoot: root,
    releaseToolFingerprint: sha, installerSha256: sha, recoveryLauncherSha256: sha,
    dependencyVerifierSha256: sha, clientVerifierSha256: sha, dependencyProofAlgorithm: 'production-closure-v1',
    dependencyLockPhysicalTreeFingerprint: sha, dependencyInstalledPhysicalTreeFingerprint: sha,
    dependencyPackageCount: 1, dependencyFileCount: 1, dependencyBytes: 1,
    buildFingerprint: sha, runtimeClosureFingerprint: sha, activeClientProofAlgorithm: 'active-client-v2',
    activeClientAssetFingerprint: sha, activeClientChunkCount: 1, activeClientAssetCount: 1,
    runtimeFiles: [{ path: 'dist/server/main.js', size: 1, sha256: sha }, { path: 'dist/shared/index.js', size: 1, sha256: sha }],
    activeClientFiles: [{ path: 'dist/client/index.html', size: 1, sha256: sha }],
    releaseFiles: [{ targetPath: 'start.ps1', size: 1, sha256: sha }] };
  receipt.receiptChecksum = relay.receiptChecksum(receipt);
  const manifest = { packageId: receipt.deploymentId, ...receipt,
    payloadFiles: receipt.runtimeFiles, activeClientFiles: receipt.activeClientFiles,
    releaseFiles: receipt.releaseFiles };
  const journal = { schemaVersion: 1, transactionId: '6a7c6e5c-1234-4567-8123-918238712312',
    deploymentId: receipt.deploymentId, appRoot: root, intent: 'deploy', phase: 'finalized',
    releaseFiles: receipt.releaseFiles.map(f => ({ targetPath: f.targetPath,
      baselineExisted: false, baselineSha256: '', candidateSha256: f.sha256 })) };
  journal.transactionChecksum = relay.journalChecksum(journal);
  return { schemaVersion: 1, innerSha256: sha, receipt, journal, manifest,
    completedAt: '2026-09-08T06:00:00.000Z', productionRoot: root };
}
run('real PowerShell receipt checksum is compatible', () => {
  const receipt = fixture().receipt; delete receipt.receiptChecksum;
  const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64');
  const command = `$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; $j=$r|ConvertTo-Json -Depth 10 -Compress; $s=[Security.Cryptography.SHA256]::Create(); ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($j)))).Replace('-','').ToLowerInvariant()`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(relay.receiptChecksum(receipt), result.stdout.trim());
});
run('accepts finalized exact receipt, rejects unfinished/wrong root/corruption', () => {
  const e = fixture();
  assert.equal(relay.validateEvidence(e, { expectedRoot: root, innerSha256: sha, manifest: e.manifest }).deploymentId, e.receipt.deploymentId);
  for (const mutate of [e => e.journal.phase = 'committed', e => e.receipt.appRoot = 'C:\\test',
    e => e.receipt.runtimeFiles[0].sha256 = 'b'.repeat(64), e => e.innerSha256 = 'b'.repeat(64),
    e => e.journal.transactionChecksum = '0'.repeat(64)]) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => relay.validateEvidence(changed, { expectedRoot: root, innerSha256: sha, manifest: e.manifest }));
  }
});
run('valid self-checksum cannot substitute a different runtime for registered manifest', () => {
  const e = fixture(); const manifest = structuredClone(e.manifest);
  e.receipt.runtimeFiles[0].sha256 = 'b'.repeat(64);
  e.receipt.receiptChecksum = relay.receiptChecksum(e.receipt);
  assert.throws(() => relay.validateEvidence(e, { expectedRoot: root, innerSha256: sha, manifest }));
});
run('authenticated encrypted evidence roundtrip and tamper rejection', () => {
  const e = fixture(); const key = 'test-only-not-a-production-secret';
  const sealed = relay.seal(e, key);
  assert.ok(!sealed.includes('appRoot'));
  assert.deepEqual(relay.open(sealed, key), e);
  assert.throws(() => relay.open(sealed, 'wrong-key'));
  const parsed = JSON.parse(sealed); parsed.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => relay.open(JSON.stringify(parsed), key));
});
run('idle sync requires no credentials or network and does not change ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-relay-idle-'));
  try { assert.deepEqual(await relay.syncWorkspace(dir), { status: 'idle' }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
run('deadline bounds stalled external IO', async () => {
  const start = Date.now();
  await assert.rejects(relay.deadline(new Promise(() => {}), 25), /deadline/);
  assert.ok(Date.now() - start < 500);
});
run('duplicate is no-op and older release never overwrites current production', () => {
  const e = fixture(); const production = { deploymentId: e.receipt.deploymentId, innerSha256: sha };
  assert.equal(relay.registrationDecision(production, e), 'same');
  production.deploymentId = 'nantong-safe-full-runtime-hotfix-20260909-000000';
  assert.equal(relay.registrationDecision(production, e), 'older');
  production.deploymentId = 'nantong-safe-full-runtime-hotfix-20260907-000000';
  assert.equal(relay.registrationDecision(production, e), 'new');
});
run('outer hook is success-only and does not wait for network', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../scripts/install-hotfix-one-click.ps1'), 'utf8');
  const pos = text.indexOf('Invoke-HotfixReceiptRelay -');
  assert.ok(pos > text.indexOf('$installerCompleted = $true'));
  assert.ok(text.includes('# RECEIPT_RELAY_HOOK'));
});
run('receiver persists authenticated receipt, updates ledger once and performs no second network read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-relay-sync-'));
  try {
    const e = fixture(), entry = { expectedRoot: root, innerSha256: sha, manifest: e.manifest,
      outerPackage: 'known.zip', outerSha256: sha };
    fs.mkdirSync(path.join(dir, 'docs/engineering'), { recursive: true });
    relay.atomic(path.join(dir, 'docs/engineering/production-release-state.json'), { production: {
      deploymentId: 'nantong-safe-full-runtime-hotfix-20260907-000000', innerSha256: sha }, nextRelease: { manualBaselineExportRequired: false } });
    relay.atomic(path.join(dir, '.release-receipts/pending.json'), [entry]);
    let requests = 0;
    const transport = { secret: 'test-secret', cos: { async getObject() { requests++; return { Body: relay.seal(e, 'test-secret') }; } } };
    assert.equal((await relay.syncWorkspace(dir, { transport })).status, 'registered');
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'docs/engineering/production-release-state.json')));
    assert.equal(ledger.production.serverReceipt.copiedToLocalWorkspace, true);
    assert.equal(ledger.production.deploymentId, e.receipt.deploymentId);
    assert.equal((await relay.syncWorkspace(dir, { transport })).status, 'idle');
    assert.equal(requests, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
run('failed fetch preserves pending queue and ledger byte-for-byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-relay-offline-'));
  try {
    const e = fixture();
    const file = path.join(dir, '.release-receipts/pending.json');
    relay.atomic(file, [{ expectedRoot: root, innerSha256: sha, manifest: e.manifest }]);
    const before = fs.readFileSync(file);
    const transport = { cos: { async getObject() { throw new Error('offline'); } } };
    await assert.rejects(relay.syncWorkspace(dir, { transport }));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.ok(!fs.existsSync(path.join(dir, 'docs/engineering/production-release-state.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
run('publisher rejects fixtures before trying to load credentials', async () => {
  await assert.rejects(relay.publish('D:\\test-app'), /production-root-mismatch/);
});
run('relay file operations reject symbolic links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-relay-link-'));
  try {
    const target = path.join(dir, 'target'); fs.mkdirSync(target);
    const link = path.join(dir, 'linked'); fs.symlinkSync(target, link, 'junction');
    assert.throws(() => relay.atomic(path.join(link, 'bad.json'), {}), /linked-path/);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
run('storage probe writes only a unique encrypted canary and removes it after readback', async () => {
  const objects = new Map();
  const cfg = { secret: 'canary-test-secret', Bucket: 'test', Region: 'test', cos: {
    async putObject(p) { assert.equal(p.ACL, 'private'); assert.match(p.Key, /\/canary\//); objects.set(p.Key, p.Body); },
    async getObject(p) { return { Body: objects.get(p.Key) }; },
    async deleteObject(p) { objects.delete(p.Key); }
  } };
  const result = await relay.probeStorage(cfg);
  assert.equal(result.status, 'storage-verified');
  assert.equal(objects.size, 0);
});
run('failed private read removes only its own canary and exposes a sanitized stage', async () => {
  let saved, removed;
  const cfg = { secret: 'test-only', cos: {
    async putObject(p) { saved = p.Key; },
    async getObject() { const e = new Error('sensitive-signed-url'); e.code = 'AccessDenied'; e.statusCode = 403; throw e; },
    async deleteObject(p) { removed = p.Key; }
  } };
  await assert.rejects(relay.probeStorage(cfg), { message: 'canary-read-failed', code: 'AccessDenied', statusCode: 403 });
  assert.equal(saved, removed);
});
run('PowerShell hook persists an outbox and detaches worker; worker failure cannot escape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-hook-'));
  try {
    const e = fixture();
    const quote = s => s.replaceAll("'", "''");
    let hook = fs.readFileSync(path.resolve(__dirname, '../../scripts/hotfix-receipt-hook.ps1'), 'utf8');
    hook = hook.replaceAll(root, dir);
    hook = hook.replace('__RELAY_BASE64__', Buffer.from('// inert fixture helper').toString('base64'));
    e.receipt.appRoot = dir; e.journal.appRoot = dir;
    fs.writeFileSync(path.join(dir, '.hotfix-installed-release.json'), JSON.stringify(e.receipt));
    fs.writeFileSync(path.join(dir, '.hotfix-transaction.json'), JSON.stringify(e.journal));
    fs.writeFileSync(path.join(dir, 'hotfix-manifest.json'), JSON.stringify(e.manifest));
    const script = path.join(dir, 'fixture.ps1');
    fs.writeFileSync(script, `${hook}\nfunction Set-Acl { param($LiteralPath,$AclObject) }\nfunction Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError) if ($WindowStyle -ne 'Hidden') { throw 'visible-worker' }; [IO.File]::WriteAllText('${quote(path.join(dir, 'detached.txt'))}', 'ok'); throw 'simulated-spawn-failure' }\nInvoke-HotfixReceiptRelay -Root '${quote(dir)}' -NodePath '${quote(process.execPath)}' -ManifestPath '${quote(path.join(dir, 'hotfix-manifest.json'))}' -InnerSha256 '${sha}'\nWrite-Host 'HOOK_RETURNED'\n`, 'utf8');
    const start = Date.now();
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HOOK_RETURNED/);
    assert.ok(fs.existsSync(path.join(dir, 'detached.txt')), result.stdout);
    const job = JSON.parse(fs.readFileSync(path.join(dir, '.hotfix-receipt-relay/pending', `${e.receipt.deploymentId}.json`), 'utf8'));
    assert.equal(job.innerSha256, sha); assert.equal(job.journal.phase, 'finalized');
    assert.ok(Date.now() - start < 10000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
