import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectHotfixReleaseProof } from '../../server/common/hotfix-release-proof';

const { journalChecksum, receiptChecksum } = require('../../scripts/hotfix-receipt-relay.cjs') as {
  journalChecksum: (value: Record<string, unknown>) => string;
  receiptChecksum: (value: Record<string, unknown>) => string;
};
const identityPath = 'dist/server/hotfix-runtime-identity.json';
const candidate = 'nantong-safe-full-runtime-hotfix-20261016-000001';
const baseline = 'nantong-safe-full-runtime-hotfix-20261015-144241';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('read-only hotfix activation proof', () => {
  let root: string, parent: string, owner: string;
  let journal: Record<string, unknown>;
  const put = (relative: string, value: unknown) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const stamp = (deploymentId = candidate) => put(identityPath, { schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId });
  const transaction = (phase: string, deploymentId = candidate) => {
    journal = {
      schemaVersion: 1, transactionId: randomUUID(), deploymentId, appRoot: root,
      intent: 'deploy', phase,
      releaseFiles: [{ targetPath: 'package.json', baselineExisted: true, baselineSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64) }],
    };
    put('.hotfix-transaction.json', { ...journal, transactionChecksum: journalChecksum(journal) });
  };
  const maintenance = () => put('.maintenance.lock', {
    schemaVersion: 1, pid: process.pid, processStartTime: new Date().toISOString(),
    transactionId: journal.transactionId, deploymentId: journal.deploymentId, appRoot: root,
  });
  const installed = (deploymentId = candidate) => {
    const digest = 'c'.repeat(64);
    const receipt = {
      schemaVersion: 2, receiptType: 'nantong-hotfix-installed-release', deploymentId, appRoot: root,
      releaseToolFingerprint: digest, installerSha256: digest, recoveryLauncherSha256: digest,
      dependencyVerifierSha256: digest, clientVerifierSha256: digest,
      dependencyProofAlgorithm: 'sha256-package-lock-production-closure-v1',
      dependencyLockPhysicalTreeFingerprint: digest, dependencyInstalledPhysicalTreeFingerprint: digest,
      dependencyPackageCount: 1, dependencyFileCount: 1, dependencyBytes: 1,
      buildFingerprint: digest, runtimeClosureFingerprint: digest,
      activeClientProofAlgorithm: 'sha256-active-client-closure-v2', activeClientAssetFingerprint: digest,
      activeClientChunkCount: 1, activeClientAssetCount: 1,
      runtimeFiles: [{ path: identityPath, size: readFileSync(join(root, identityPath)).length, sha256: hash(readFileSync(join(root, identityPath))) }],
      activeClientFiles: [{ path: 'dist/client/index.html', size: 1, sha256: digest }],
      releaseFiles: [{ targetPath: 'package.json', size: 1, sha256: 'b'.repeat(64) }],
    };
    put('.hotfix-installed-release.json', { ...receipt, receiptChecksum: receiptChecksum(receipt) });
  };

  beforeEach(() => {
    parent = realpathSync(tmpdir()); root = mkdtempSync(join(parent, 'nt-release-proof-'));
    owner = randomUUID(); writeFileSync(join(root, '.test-owner'), owner, { flag: 'wx' });
  });
  afterEach(() => {
    const same = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
    if (!same(dirname(root), parent) || !/^nt-release-proof-[A-Za-z0-9]+$/.test(basename(root)) ||
        lstatSync(root).isSymbolicLink() || !same(realpathSync(root), root) ||
        readFileSync(join(root, '.test-owner'), 'utf8') !== owner) throw Error('Unowned release proof fixture');
    const check = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const file = join(directory, name), stats = lstatSync(file);
        if (stats.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture entry');
        if (stats.isDirectory()) check(file);
        else if (!stats.isFile() || stats.nlink !== 1) throw Error('Unexpected fixture entry');
      }
    };
    check(root); rmSync(root, { recursive: true });
  });

  it('leaves an unmanaged development root unchanged', () => {
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'unmanaged', canInitialize: true, canAcceptNewWork: true });
    expect(readdirSync(root)).toEqual(['.test-owner']);
  });
  it('holds a matching candidate before commit', () => {
    stamp(); transaction('candidate-started'); maintenance();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'candidate-held', maintenance: true, canInitialize: false, canAcceptNewWork: false, deploymentId: candidate });
  });
  it('does not unlock merely because the maintenance file was deleted', () => {
    stamp(); transaction('candidate-started');
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'candidate-held', canInitialize: false, canAcceptNewWork: false });
  });
  it('allows committed initialization but not new business while finalization is pending', () => {
    stamp(); transaction('committed'); maintenance();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'candidate-committed', canInitialize: true, canAcceptNewWork: false });
  });
  it('requires a matching receipt before opening finalized candidate business', () => {
    stamp(); transaction('finalized');
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
    installed();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'installed', canInitialize: true, canAcceptNewWork: true });
  });
  it('supports an installed runtime with a valid receipt and no journal', () => {
    stamp(); installed();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'installed', canAcceptNewWork: true });
  });
  it('keeps the baseline held until rollback has actually completed', () => {
    stamp(baseline); installed(baseline); transaction('candidate-started'); maintenance();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'baseline-held', canInitialize: false });
    transaction('rolled-back'); rmSync(join(root, '.maintenance.lock'));
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'baseline-restored', canInitialize: true, canAcceptNewWork: true });
  });
  it('does not reactivate the baseline after the candidate has committed', () => {
    stamp(baseline); installed(baseline); transaction('committed'); maintenance();
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('refuses changed journal bytes without a new valid checksum', () => {
    stamp(); transaction('candidate-started');
    const file = join(root, '.hotfix-transaction.json');
    const value = JSON.parse(readFileSync(file, 'utf8')); value.phase = 'committed'; put('.hotfix-transaction.json', value);
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'invalid', canInitialize: false, canAcceptNewWork: false });
  });
  it('refuses a finalized receipt for different runtime identity bytes', () => {
    stamp(); transaction('finalized'); installed();
    put(identityPath, { schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId: baseline });
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('fails closed when managed metadata exists without runtime identity', () => {
    transaction('candidate-started'); maintenance();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'invalid', canInitialize: false });
    expect(existsSync(join(root, identityPath))).toBe(false);
  });
  it('does not treat a stamped but unregistered runtime as development', () => {
    stamp();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'invalid', canAcceptNewWork: false });
  });
  it('keeps finalized business closed while the maintenance owner remains', () => {
    stamp(); transaction('finalized'); installed(); maintenance();
    expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'installed', canInitialize: true, canAcceptNewWork: false });
  });
  it('rejects a marker that belongs to a different transaction', () => {
    stamp(); transaction('committed'); maintenance();
    const value = JSON.parse(readFileSync(join(root, '.maintenance.lock'), 'utf8'));
    put('.maintenance.lock', { ...value, transactionId: randomUUID() });
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('rejects a validly checksummed journal for another application root', () => {
    stamp(); transaction('committed');
    journal.appRoot = join(root, 'another-app');
    put('.hotfix-transaction.json', { ...journal, transactionChecksum: journalChecksum(journal) });
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('rejects a validly checksummed but unknown transaction phase', () => {
    stamp(); transaction('unrecognized-phase');
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('does not start a candidate whose transaction was rolled back', () => {
    stamp(); transaction('rolled-back'); installed();
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('rejects a modified installed receipt without a matching checksum', () => {
    stamp(); transaction('finalized'); installed();
    const value = JSON.parse(readFileSync(join(root, '.hotfix-installed-release.json'), 'utf8'));
    put('.hotfix-installed-release.json', { ...value, dependencyFileCount: 2 });
    expect(inspectHotfixReleaseProof(root).mode).toBe('invalid');
  });
  it('matches existing PowerShell-compatible checksums for apostrophe and Unicode roots', () => {
    const fixtureRoot = root;
    root = join(fixtureRoot, "O'Brien 子目录"); mkdirSync(root);
    try {
      stamp(); transaction('finalized'); installed();
      expect(inspectHotfixReleaseProof(root)).toMatchObject({ mode: 'installed', canAcceptNewWork: true });
    } finally { root = fixtureRoot; }
  });
});
