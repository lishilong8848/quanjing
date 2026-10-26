export interface HotfixReleaseProof {
  mode: 'unmanaged' | 'candidate-held' | 'candidate-committed' | 'installed' | 'baseline-held' | 'baseline-restored' | 'invalid';
  maintenance: boolean;
  canInitialize: boolean;
  canAcceptNewWork: boolean;
  deploymentId?: string;
  transactionId?: string;
  reason?: string;
}

const IDENTITY = 'dist/server/hotfix-runtime-identity.json';
const PROTOCOL = 'maintenance-commit-v1';
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^nantong-safe-full-runtime-hotfix-\d{8}-\d{6,9}$/;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RECEIPT_FIELDS = ['schemaVersion', 'receiptType', 'deploymentId', 'appRoot',
  'releaseToolFingerprint', 'installerSha256', 'recoveryLauncherSha256', 'dependencyVerifierSha256',
  'clientVerifierSha256', 'dependencyProofAlgorithm', 'dependencyLockPhysicalTreeFingerprint',
  'dependencyInstalledPhysicalTreeFingerprint', 'dependencyPackageCount', 'dependencyFileCount',
  'dependencyBytes', 'buildFingerprint', 'runtimeClosureFingerprint', 'activeClientProofAlgorithm',
  'activeClientAssetFingerprint', 'activeClientChunkCount', 'activeClientAssetCount',
  'runtimeFiles', 'activeClientFiles', 'releaseFiles'] as const;
const PHASES = new Set(['stage-intent', 'prepared', 'runtime-stopped', 'dist-backup-intent', 'dist-backed-up',
  'candidate-dist-intent', 'candidate-dist-installed', 'release-files-installed', 'candidate-started',
  'candidate-healthy', 'committed', 'finalized', 'rolled-back']);
type ObjectValue = Record<string, unknown>;
type Loaded = { value: ObjectValue; sha256: string; size: number };

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: string) => {
  const path = normalize(resolve(value)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
};
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: ObjectValue, keys: readonly string[]): void {
  check(Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), 'UNEXPECTED_FIELDS');
}
function pick(value: ObjectValue, keys: readonly string[]): ObjectValue {
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
// Same canonical field order and escaping as the existing PowerShell/relay proofs.
function proofHash(value: ObjectValue): string {
  return digest(JSON.stringify(value).replace(/'/g, '\\u0027').replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
}
function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/[\\:\x00-\x1f*?"<>|]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function rootMatches(value: unknown, root: string): boolean {
  return typeof value === 'string' && isAbsolute(value) && canonical(value) === canonical(root);
}
function load(file: string): Loaded | undefined {
  let before;
  try { before = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 4 * 1024 * 1024 &&
    canonical(realpathSync(file)) === canonical(file), 'UNSAFE_PROOF_FILE');
  const bytes = readFileSync(file), after = lstatSync(file);
  check(after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.dev === before.dev &&
    after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs &&
    bytes.length === before.size && canonical(realpathSync(file)) === canonical(file), 'PROOF_CHANGED_DURING_READ');
  const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  check(object(value), 'INVALID_PROOF_OBJECT');
  return { value, sha256: digest(bytes), size: bytes.length };
}
function validateJournal(value: ObjectValue, root: string): void {
  exact(value, ['schemaVersion', 'transactionId', 'deploymentId', 'appRoot', 'intent', 'phase', 'releaseFiles', 'transactionChecksum']);
  check(value.schemaVersion === 1 && typeof value.transactionId === 'string' && GUID.test(value.transactionId) &&
    typeof value.deploymentId === 'string' && RELEASE.test(value.deploymentId) && rootMatches(value.appRoot, root) &&
    value.intent === 'deploy' && typeof value.phase === 'string' && PHASES.has(value.phase), 'INVALID_TRANSACTION');
  check(Array.isArray(value.releaseFiles) && value.releaseFiles.length > 0 && value.releaseFiles.length <= 4096, 'INVALID_TRANSACTION_ROOTS');
  const seen = new Set<string>();
  for (const item of value.releaseFiles) {
    check(object(item), 'INVALID_TRANSACTION_ROOT'); exact(item, ['targetPath', 'baselineExisted', 'baselineSha256', 'candidateSha256']);
    check(relativePath(item.targetPath) && !seen.has(item.targetPath.toLowerCase()) && typeof item.baselineExisted === 'boolean' &&
      typeof item.baselineSha256 === 'string' && (item.baselineExisted ? HASH.test(item.baselineSha256) : item.baselineSha256 === '') &&
      typeof item.candidateSha256 === 'string' && HASH.test(item.candidateSha256), 'INVALID_TRANSACTION_ROOT');
    seen.add(item.targetPath.toLowerCase());
  }
  const payload = pick(value, ['schemaVersion', 'transactionId', 'deploymentId', 'appRoot', 'intent', 'phase']);
  payload.releaseFiles = value.releaseFiles.map(item => pick(item, ['targetPath', 'baselineExisted', 'baselineSha256', 'candidateSha256']));
  check(typeof value.transactionChecksum === 'string' && HASH.test(value.transactionChecksum) &&
    proofHash(payload) === value.transactionChecksum, 'TRANSACTION_CHECKSUM_MISMATCH');
}
function validateMarker(value: ObjectValue, root: string, journal: ObjectValue): void {
  exact(value, ['schemaVersion', 'pid', 'processStartTime', 'transactionId', 'deploymentId', 'appRoot']);
  check(value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.processStartTime === 'string' && Number.isFinite(Date.parse(value.processStartTime)) &&
    rootMatches(value.appRoot, root) && value.transactionId === journal.transactionId &&
    value.deploymentId === journal.deploymentId, 'MAINTENANCE_IDENTITY_MISMATCH');
}
function validateReceipt(value: ObjectValue, root: string, identity: Loaded): void {
  exact(value, [...RECEIPT_FIELDS, 'receiptChecksum']);
  check(value.schemaVersion === 2 && value.receiptType === 'nantong-hotfix-installed-release' &&
    value.deploymentId === identity.value.deploymentId && rootMatches(value.appRoot, root), 'RECEIPT_RUNTIME_MISMATCH');
  for (const key of ['releaseToolFingerprint', 'installerSha256', 'recoveryLauncherSha256', 'dependencyVerifierSha256',
    'clientVerifierSha256', 'dependencyLockPhysicalTreeFingerprint', 'dependencyInstalledPhysicalTreeFingerprint',
    'buildFingerprint', 'runtimeClosureFingerprint', 'activeClientAssetFingerprint']) {
    check(typeof value[key] === 'string' && HASH.test(value[key]), 'INVALID_RECEIPT_HASH');
  }
  for (const key of ['dependencyPackageCount', 'dependencyFileCount', 'dependencyBytes', 'activeClientChunkCount', 'activeClientAssetCount']) {
    check(Number.isSafeInteger(value[key]) && Number(value[key]) > 0, 'INVALID_RECEIPT_COUNT');
  }
  check(value.dependencyProofAlgorithm === 'sha256-package-lock-production-closure-v1' &&
    value.activeClientProofAlgorithm === 'sha256-active-client-closure-v2', 'INVALID_RECEIPT_ALGORITHM');
  const payload = pick(value, RECEIPT_FIELDS);
  let identityMatched = false;
  for (const listKey of ['runtimeFiles', 'activeClientFiles', 'releaseFiles'] as const) {
    const list = value[listKey];
    check(Array.isArray(list) && list.length > 0 && list.length < 10000, 'INVALID_RECEIPT_FILES');
    const nameKey = listKey === 'releaseFiles' ? 'targetPath' : 'path', seen = new Set<string>();
    payload[listKey] = list.map(item => {
      check(object(item), 'INVALID_RECEIPT_ENTRY'); exact(item, [nameKey, 'size', 'sha256']);
      const name = item[nameKey];
      check(relativePath(name) && !seen.has(name.toLowerCase()) && Number.isSafeInteger(item.size) && Number(item.size) >= 0 &&
        typeof item.sha256 === 'string' && HASH.test(item.sha256), 'INVALID_RECEIPT_ENTRY');
      check(listKey === 'releaseFiles' ? !name.startsWith('dist/') : listKey === 'activeClientFiles' ? name.startsWith('dist/client/') :
        name.startsWith('dist/server/') || name.startsWith('dist/shared/'), 'INVALID_RECEIPT_SCOPE');
      seen.add(name.toLowerCase());
      if (listKey === 'runtimeFiles' && name === IDENTITY) {
        check(item.sha256 === identity.sha256 && item.size === identity.size, 'RUNTIME_IDENTITY_BYTES_MISMATCH'); identityMatched = true;
      }
      return pick(item, [nameKey, 'size', 'sha256']);
    });
  }
  check(identityMatched && (value.activeClientFiles as unknown[]).length === value.activeClientAssetCount &&
    Number(value.activeClientChunkCount) <= Number(value.activeClientAssetCount), 'RUNTIME_IDENTITY_NOT_PROVEN');
  check(typeof value.receiptChecksum === 'string' && HASH.test(value.receiptChecksum) &&
    proofHash(payload) === value.receiptChecksum, 'RECEIPT_CHECKSUM_MISMATCH');
}

export function inspectHotfixReleaseProof(appRoot: string): HotfixReleaseProof {
  let maintenance = false;
  try {
    check(isAbsolute(appRoot) && canonical(realpathSync(appRoot)) === canonical(appRoot) &&
      lstatSync(appRoot).isDirectory() && !lstatSync(appRoot).isSymbolicLink(), 'INVALID_APPLICATION_ROOT');
    const marker = load(join(appRoot, '.maintenance.lock'));
    maintenance = !!marker;
    const journal = load(join(appRoot, '.hotfix-transaction.json'));
    const identity = load(join(appRoot, IDENTITY));
    const receipt = () => load(join(appRoot, '.hotfix-installed-release.json'));
    if (!identity) {
      check(!marker && !journal && !receipt(), 'MANAGED_RUNTIME_IDENTITY_MISSING');
      return { mode: 'unmanaged', maintenance: false, canInitialize: true, canAcceptNewWork: true };
    }
    exact(identity.value, ['schemaVersion', 'activationProtocol', 'deploymentId']);
    check(identity.value.schemaVersion === 1 && identity.value.activationProtocol === PROTOCOL &&
      typeof identity.value.deploymentId === 'string' && RELEASE.test(identity.value.deploymentId), 'INVALID_RUNTIME_IDENTITY');
    const deploymentId = identity.value.deploymentId;
    const result = (mode: HotfixReleaseProof['mode'], canInitialize: boolean, canAcceptNewWork: boolean): HotfixReleaseProof =>
      ({ mode, maintenance, canInitialize, canAcceptNewWork, deploymentId,
        ...(journal ? { transactionId: String(journal.value.transactionId) } : {}) });
    const installedReceipt = () => {
      const value = receipt(); check(value, 'INSTALLED_RECEIPT_MISSING'); validateReceipt(value.value, appRoot, identity);
    };
    if (!journal) {
      check(!marker, 'TRANSACTION_MISSING'); installedReceipt(); return result('installed', true, true);
    }
    validateJournal(journal.value, appRoot);
    if (marker) validateMarker(marker.value, appRoot, journal.value);
    const phase = journal.value.phase;
    if (journal.value.deploymentId === deploymentId) {
      check(phase !== 'rolled-back', 'ROLLED_BACK_CANDIDATE');
      if (phase === 'finalized') { installedReceipt(); return result('installed', true, !maintenance); }
      if (phase === 'committed') return result('candidate-committed', true, false);
      return result('candidate-held', false, false);
    }
    installedReceipt();
    check(phase !== 'committed' && phase !== 'finalized', 'COMMITTED_RUNTIME_MISMATCH');
    if (phase === 'rolled-back') return result('baseline-restored', true, !maintenance);
    return result('baseline-held', false, false);
  } catch (error) {
    return { mode: 'invalid', maintenance, canInitialize: false, canAcceptNewWork: false,
      reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNREADABLE_RELEASE_PROOF' };
  }
}
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

