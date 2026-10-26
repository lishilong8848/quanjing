import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DELIVERY_STATE_FILE_NAME = 'weather-warning-delivery-state.json';
const MAX_LEASE_AGE_MS = 10 * 60 * 1000;
const STRICT_UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/u;
const OWNER_MARKER_PREFIX = 'owner-';
const RELEASED_MARKER_PREFIX = 'released-';
const LEASE_MARKER_SUFFIX = '.lease';
const RECOVERY_CLAIM_PREFIX = 'recovery-';
const RECOVERY_CLAIM_FILE_NAME = 'claim.json';
const RECOVERY_PENDING_SEGMENT = '.recovery-pending.';
const LEGACY_RECOVERY_MARKER_FILE = '.recovery';
const LEGACY_RECOVERY_TAKEOVER_SUFFIX = '-takeover';
const FENCE_TOKEN =
  /^(\d+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DELIVERY_ENTRY_FIELDS = [
  'clientMutationId',
  'messageId',
  'sentAt',
  'uuid',
  'snapshotSignature',
] as const;

type WeatherWarningDeliveryEntry = {
  clientMutationId: string;
  messageId: string;
  sentAt: string;
  uuid: string;
  snapshotSignature: string;
};

type DeliveryLeaseOwnership = {
  leasePath: string;
  token: string;
  markerPath: string;
  releasedMarkerPath: string;
};

type LeaseFenceMetadata = {
  token: string;
  acquiredAt: string;
};

type LeaseMarker = {
  name: string;
  metadata: LeaseFenceMetadata;
};

type RecoveryFence = LeaseMarker & {
  kind: 'claim' | 'legacy';
};

type PathInspection =
  | { kind: 'missing' }
  | { kind: 'file' }
  | { kind: 'directory' }
  | { kind: 'unsafe' };

type LeaseDirectorySnapshot = {
  kind: 'missing' | 'file' | 'directory' | 'unsafe';
  owners: LeaseMarker[];
  released: LeaseMarker[];
  recoveries: RecoveryFence[];
  hasInvalidEntries: boolean;
  hasUnknownEntries: boolean;
};

type LeaseInspection =
  | { kind: 'missing' }
  | { kind: 'active' }
  | { kind: 'reclaimable'; snapshot: LeaseDirectorySnapshot };

type RecoveryClaim = {
  path: string;
  name: string;
  token: string;
};

type ProcessLiveness = 'alive' | 'dead' | 'unknown';

export interface WeatherWarningDeliveryState {
  version: 1;
  entries: Record<string, WeatherWarningDeliveryEntry>;
}

export interface DeliveryStoreOptions {
  explicitPath?: string;
  configuredDirectory?: string;
  now?: Date;
  cwd?: string;
}

export interface DeliveryLease {
  release(): void;
}

export function readWeatherWarningDeliveryStateFile(
  options: DeliveryStoreOptions = {},
): WeatherWarningDeliveryState {
  const statePath = resolveDeliveryStatePath(options);

  try {
    const details = lstatSync(statePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('state file is not a regular file');
    }
    return parsePersistedState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw new Error('天气预警测试发送状态文件损坏');
  }
}

export function writeWeatherWarningDeliveryStateFile(
  state: WeatherWarningDeliveryState,
  options: DeliveryStoreOptions = {},
): void {
  let persistedState: WeatherWarningDeliveryState;
  try {
    persistedState = sanitizeStateForWrite(state);
  } catch {
    throw new Error('天气预警测试发送状态无效');
  }

  const statePath = resolveDeliveryStatePath(options);
  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(persistedState, null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, statePath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}

export function acquireWeatherWarningDeliveryLease(
  options: DeliveryStoreOptions = {},
): DeliveryLease | null {
  const statePath = resolveDeliveryStatePath(options);
  const leasePath = `${statePath}.lock`;
  const now = resolveNow(options.now);
  const token = `${process.pid}:${randomUUID()}`;

  mkdirSync(dirname(leasePath), { recursive: true });
  const firstOwnership = tryCreateLeaseDirectory(leasePath, token, now);
  if (firstOwnership) return createDeliveryLease(firstOwnership);

  const inspection = inspectExistingLease(leasePath, now);
  if (inspection.kind === 'active') return null;
  if (inspection.kind === 'reclaimable') {
    if (!reclaimLeaseDirectory(leasePath, inspection, now)) return null;
  }

  const replacementOwnership = tryCreateLeaseDirectory(leasePath, token, now);
  return replacementOwnership
    ? createDeliveryLease(replacementOwnership)
    : null;
}

function emptyState(): WeatherWarningDeliveryState {
  return { version: 1, entries: {} };
}

function resolveDeliveryStatePath(options: DeliveryStoreOptions): string {
  const explicitPath = nonEmptyString(options.explicitPath);
  if (explicitPath) return resolve(explicitPath);

  const configuredDirectory = nonEmptyString(options.configuredDirectory);
  if (configuredDirectory) {
    return join(resolve(configuredDirectory), DELIVERY_STATE_FILE_NAME);
  }

  const cwd = nonEmptyString(options.cwd) ?? process.cwd();
  return join(resolve(cwd), 'data', DELIVERY_STATE_FILE_NAME);
}

function parsePersistedState(value: unknown): WeatherWarningDeliveryState {
  return normalizeState(value, { rejectUnknownFields: true });
}

function sanitizeStateForWrite(value: unknown): WeatherWarningDeliveryState {
  return normalizeState(value, { rejectUnknownFields: false });
}

function normalizeState(
  value: unknown,
  options: { rejectUnknownFields: boolean },
): WeatherWarningDeliveryState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    throw new Error('state shape is invalid');
  }
  if (options.rejectUnknownFields) {
    assertOnlyAllowedFields(value, ['version', 'entries']);
  }

  const entries: Record<string, WeatherWarningDeliveryEntry> = {};
  for (const [entryKey, rawEntry] of Object.entries(value.entries)) {
    if (!isSafeEntryKey(entryKey)) {
      throw new Error('entry key is invalid');
    }
    entries[entryKey] = normalizeEntry(rawEntry, entryKey, options);
  }

  return { version: 1, entries };
}

function normalizeEntry(
  value: unknown,
  entryKey: string,
  options: { rejectUnknownFields: boolean },
): WeatherWarningDeliveryEntry {
  if (!isRecord(value)) throw new Error('entry is invalid');
  if (options.rejectUnknownFields) {
    assertOnlyAllowedFields(value, DELIVERY_ENTRY_FIELDS);
  }

  const entry = {
    clientMutationId: requiredString(value.clientMutationId),
    messageId: requiredFeishuMessageId(value.messageId),
    sentAt: requiredTimestamp(value.sentAt),
    uuid: requiredString(value.uuid),
    snapshotSignature: requiredString(value.snapshotSignature),
  };
  if (entry.clientMutationId !== entryKey) {
    throw new Error('entry key does not match clientMutationId');
  }

  return entry;
}

function assertOnlyAllowedFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  if (Object.keys(value).some((field) => !allowedFields.includes(field))) {
    throw new Error('unexpected field');
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('string is required');
  }
  return value;
}

function requiredTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  if (!isStrictUtcTimestamp(timestamp)) {
    throw new Error('timestamp is invalid');
  }
  return timestamp;
}

function isStrictUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = STRICT_UTC_TIMESTAMP.exec(value);
  if (!match) return false;

  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`;
  try {
    return new Date(value).toISOString() === normalized;
  } catch {
    return false;
  }
}

function requiredFeishuMessageId(value: unknown): string {
  const messageId = requiredString(value);
  if (!FEISHU_MESSAGE_ID.test(messageId)) {
    throw new Error('messageId is invalid');
  }
  return messageId;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeEntryKey(value: string): boolean {
  return (
    Boolean(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function resolveNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('天气预警测试发送状态锁时间无效');
  }
  return now;
}

function tryCreateLeaseDirectory(
  leasePath: string,
  token: string,
  now: Date,
): DeliveryLeaseOwnership | null {
  const markerId = randomUUID();
  const pendingPath = `${leasePath}.pending.${process.pid}.${randomUUID()}`;
  const markerName = `${OWNER_MARKER_PREFIX}${markerId}${LEASE_MARKER_SUFFIX}`;
  let pendingCreated = false;
  let published = false;

  try {
    mkdirSync(pendingPath);
    pendingCreated = true;
    if (!isSafeDirectory(pendingPath)) return null;
    if (
      !writeExclusiveLeaseFence(
        pendingPath,
        markerName,
        makeLeaseFenceMetadata(token, now),
      )
    ) {
      return null;
    }
    if (!renameSafeDirectory(pendingPath, leasePath)) return null;
    published = true;
  } catch {
    return null;
  } finally {
    if (pendingCreated && !published) {
      removeSafeDirectoryTree(pendingPath);
    }
  }

  return {
    leasePath,
    token,
    markerPath: join(leasePath, markerName),
    releasedMarkerPath: join(
      leasePath,
      `${RELEASED_MARKER_PREFIX}${markerId}${LEASE_MARKER_SUFFIX}`,
    ),
  };
}

function createDeliveryLease(ownership: DeliveryLeaseOwnership): DeliveryLease {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseLeaseIfOwned(ownership);
    },
  };
}

function inspectExistingLease(leasePath: string, now: Date): LeaseInspection {
  const snapshot = readLeaseDirectorySnapshot(leasePath);
  if (snapshot.kind === 'missing') return { kind: 'missing' };
  if (!isReclaimableSnapshot(snapshot, now)) return { kind: 'active' };
  return { kind: 'reclaimable', snapshot };
}

function reclaimLeaseDirectory(
  leasePath: string,
  expected: Extract<LeaseInspection, { kind: 'reclaimable' }>,
  now: Date,
): boolean {
  const beforeClaim = readLeaseDirectorySnapshot(leasePath);
  if (!isCompatibleForRecovery(expected.snapshot, beforeClaim, now)) {
    return false;
  }

  const recoveryClaim = tryCreateRecoveryClaim(leasePath, now);
  if (!recoveryClaim) return false;

  let quarantined = false;
  try {
    const quarantinePath = moveReclaimableLeaseToQuarantine(
      leasePath,
      expected.snapshot,
      recoveryClaim,
      now,
    );
    if (!quarantinePath) return false;
    quarantined = true;
    removeSafeDirectoryTree(quarantinePath);
    return true;
  } finally {
    if (!quarantined) {
      removeRecoveryClaimIfOwned(recoveryClaim);
    }
  }
}

function tryCreateRecoveryClaim(
  leasePath: string,
  now: Date,
): RecoveryClaim | null {
  const claimId = randomUUID();
  const claimName = `${RECOVERY_CLAIM_PREFIX}${claimId}${LEASE_MARKER_SUFFIX}`;
  const claimPath = join(leasePath, claimName);
  const pendingPath = `${leasePath}${RECOVERY_PENDING_SEGMENT}${process.pid}.${claimId}`;
  const token = `${process.pid}:${randomUUID()}`;
  let pendingCreated = false;
  let published = false;

  try {
    if (!isSafeDirectory(leasePath)) return null;
    mkdirSync(pendingPath);
    pendingCreated = true;
    if (!isSafeDirectory(pendingPath)) return null;
    if (
      !writeExclusiveLeaseFence(
        pendingPath,
        RECOVERY_CLAIM_FILE_NAME,
        makeLeaseFenceMetadata(token, now),
      )
    ) {
      return null;
    }
    if (!isSafeDirectory(leasePath)) return null;
    if (inspectPath(claimPath).kind !== 'missing') return null;
    if (!renameSafeDirectory(pendingPath, claimPath)) return null;
    published = true;
  } catch {
    return null;
  } finally {
    if (pendingCreated && !published) {
      removeSafeDirectoryTree(pendingPath);
    }
  }

  return { path: claimPath, name: claimName, token };
}

function moveReclaimableLeaseToQuarantine(
  leasePath: string,
  expected: LeaseDirectorySnapshot,
  recoveryClaim: RecoveryClaim,
  now: Date,
): string | null {
  const current = readLeaseDirectorySnapshot(leasePath);
  if (!isReadyToMoveLease(expected, current, recoveryClaim, now)) {
    return null;
  }

  const quarantinePath = `${leasePath}.stale.${randomUUID()}`;
  return renameSafeDirectory(leasePath, quarantinePath) ? quarantinePath : null;
}

function isCompatibleForRecovery(
  expected: LeaseDirectorySnapshot,
  current: LeaseDirectorySnapshot,
  now: Date,
): boolean {
  return (
    hasSamePrimaryLeaseMarkers(expected, current) &&
    containsAllExpectedRecoveryMarkers(expected, current) &&
    isReclaimableSnapshot(current, now)
  );
}

function isReadyToMoveLease(
  expected: LeaseDirectorySnapshot,
  current: LeaseDirectorySnapshot,
  recoveryClaim: RecoveryClaim,
  now: Date,
): boolean {
  if (
    !hasSamePrimaryLeaseMarkers(expected, current) ||
    !containsAllExpectedRecoveryMarkers(expected, current) ||
    current.kind !== 'directory' ||
    current.hasInvalidEntries ||
    current.hasUnknownEntries
  ) {
    return false;
  }

  return current.recoveries.every((recovery) => {
    if (recovery.name === recoveryClaim.name) {
      return (
        recovery.kind === 'claim' &&
        recovery.metadata.token === recoveryClaim.token
      );
    }
    return isFenceExpiredAndOwnerDead(recovery.metadata, now);
  });
}

function hasSamePrimaryLeaseMarkers(
  expected: LeaseDirectorySnapshot,
  current: LeaseDirectorySnapshot,
): boolean {
  return (
    expected.kind === 'directory' &&
    current.kind === 'directory' &&
    !current.hasInvalidEntries &&
    !current.hasUnknownEntries &&
    areLeaseMarkersEqual(expected.owners, current.owners) &&
    areLeaseMarkersEqual(expected.released, current.released)
  );
}

function containsAllExpectedRecoveryMarkers(
  expected: LeaseDirectorySnapshot,
  current: LeaseDirectorySnapshot,
): boolean {
  return expected.recoveries.every((expectedRecovery) =>
    current.recoveries.some(
      (currentRecovery) =>
        currentRecovery.name === expectedRecovery.name &&
        currentRecovery.kind === expectedRecovery.kind &&
        areLeaseFenceMetadataEqual(
          currentRecovery.metadata,
          expectedRecovery.metadata,
        ),
    ),
  );
}

function areLeaseMarkersEqual(
  left: LeaseMarker[],
  right: LeaseMarker[],
): boolean {
  return (
    left.length === right.length &&
    left.every((leftMarker) =>
      right.some(
        (rightMarker) =>
          rightMarker.name === leftMarker.name &&
          areLeaseFenceMetadataEqual(leftMarker.metadata, rightMarker.metadata),
      ),
    )
  );
}

function areLeaseFenceMetadataEqual(
  left: LeaseFenceMetadata,
  right: LeaseFenceMetadata,
): boolean {
  return left.token === right.token && left.acquiredAt === right.acquiredAt;
}

function isReclaimableSnapshot(
  snapshot: LeaseDirectorySnapshot,
  now: Date,
): boolean {
  if (
    snapshot.kind !== 'directory' ||
    snapshot.hasInvalidEntries ||
    snapshot.hasUnknownEntries ||
    snapshot.owners.length + snapshot.released.length !== 1
  ) {
    return false;
  }

  if (
    snapshot.owners.length === 1 &&
    !isFenceExpiredAndOwnerDead(snapshot.owners[0].metadata, now)
  ) {
    return false;
  }

  return snapshot.recoveries.every((recovery) =>
    isFenceExpiredAndOwnerDead(recovery.metadata, now),
  );
}

function isFenceExpiredAndOwnerDead(
  metadata: LeaseFenceMetadata,
  now: Date,
): boolean {
  return isExpiredFence(metadata, now) && isFenceOwnerDead(metadata);
}

function isExpiredFence(metadata: LeaseFenceMetadata, now: Date): boolean {
  return (
    now.getTime() - new Date(metadata.acquiredAt).getTime() > MAX_LEASE_AGE_MS
  );
}

function isFenceOwnerDead(metadata: LeaseFenceMetadata): boolean {
  const ownerPid = getFenceOwnerPid(metadata.token);
  return ownerPid !== null && getProcessLiveness(ownerPid) === 'dead';
}

function getFenceOwnerPid(token: string): number | null {
  const separatorIndex = token.indexOf(':');
  if (separatorIndex <= 0) return null;
  const pid = Number(token.slice(0, separatorIndex));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function getProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'dead'
      : 'unknown';
  }
}

function readLeaseDirectorySnapshot(leasePath: string): LeaseDirectorySnapshot {
  const leasePathDetails = inspectPath(leasePath);
  if (leasePathDetails.kind === 'missing') return emptyLeaseSnapshot('missing');
  if (leasePathDetails.kind === 'unsafe') return emptyLeaseSnapshot('unsafe');
  if (leasePathDetails.kind !== 'directory') return emptyLeaseSnapshot('file');

  const entryNames = readSafeDirectoryEntries(leasePath);
  if (!entryNames) return emptyLeaseSnapshot('unsafe');

  const snapshot = emptyLeaseSnapshot('directory');
  for (const entryName of entryNames) {
    const ownerId = getLeaseMarkerId(entryName, OWNER_MARKER_PREFIX);
    if (ownerId) {
      const metadata = readLeaseFenceFile(join(leasePath, entryName));
      if (metadata) snapshot.owners.push({ name: entryName, metadata });
      else snapshot.hasInvalidEntries = true;
      continue;
    }

    const releasedId = getLeaseMarkerId(entryName, RELEASED_MARKER_PREFIX);
    if (releasedId) {
      const metadata = readLeaseFenceFile(join(leasePath, entryName));
      if (metadata) snapshot.released.push({ name: entryName, metadata });
      else snapshot.hasInvalidEntries = true;
      continue;
    }

    const recoveryClaimId = getRecoveryClaimId(entryName);
    if (recoveryClaimId) {
      const metadata = readRecoveryClaimDirectory(join(leasePath, entryName));
      if (metadata) {
        snapshot.recoveries.push({
          kind: 'claim',
          name: entryName,
          metadata,
        });
      } else {
        snapshot.hasInvalidEntries = true;
      }
      continue;
    }

    if (getLegacyRecoveryDepth(entryName) !== null) {
      const metadata = readLeaseFenceFile(join(leasePath, entryName));
      if (metadata) {
        snapshot.recoveries.push({
          kind: 'legacy',
          name: entryName,
          metadata,
        });
      } else {
        snapshot.hasInvalidEntries = true;
      }
      continue;
    }

    snapshot.hasUnknownEntries = true;
  }

  return snapshot;
}

function emptyLeaseSnapshot(
  kind: LeaseDirectorySnapshot['kind'],
): LeaseDirectorySnapshot {
  return {
    kind,
    owners: [],
    released: [],
    recoveries: [],
    hasInvalidEntries: false,
    hasUnknownEntries: false,
  };
}

function getLeaseMarkerId(name: string, prefix: string): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(LEASE_MARKER_SUFFIX)) {
    return null;
  }
  const id = name.slice(prefix.length, -LEASE_MARKER_SUFFIX.length);
  return /^[A-Za-z0-9-]+$/u.test(id) ? id : null;
}

function getRecoveryClaimId(name: string): string | null {
  if (
    !name.startsWith(RECOVERY_CLAIM_PREFIX) ||
    !name.endsWith(LEASE_MARKER_SUFFIX)
  ) {
    return null;
  }
  const id = name.slice(
    RECOVERY_CLAIM_PREFIX.length,
    -LEASE_MARKER_SUFFIX.length,
  );
  return UUID.test(id) ? id : null;
}

function getLegacyRecoveryDepth(name: string): number | null {
  if (name === LEGACY_RECOVERY_MARKER_FILE) return 0;
  if (!name.startsWith(LEGACY_RECOVERY_MARKER_FILE)) return null;

  let depth = 0;
  let suffix = name.slice(LEGACY_RECOVERY_MARKER_FILE.length);
  while (suffix.startsWith(LEGACY_RECOVERY_TAKEOVER_SUFFIX)) {
    depth += 1;
    suffix = suffix.slice(LEGACY_RECOVERY_TAKEOVER_SUFFIX.length);
  }

  return depth > 0 && !suffix ? depth : null;
}

function readRecoveryClaimDirectory(
  recoveryPath: string,
): LeaseFenceMetadata | null {
  if (!isSafeDirectory(recoveryPath)) return null;
  const entries = readSafeDirectoryEntries(recoveryPath);
  if (
    !entries ||
    entries.length !== 1 ||
    entries[0] !== RECOVERY_CLAIM_FILE_NAME
  ) {
    return null;
  }
  return readLeaseFenceFile(join(recoveryPath, RECOVERY_CLAIM_FILE_NAME));
}

function readLeaseFenceFile(path: string): LeaseFenceMetadata | null {
  if (!isSafeFile(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(parsed, 'token') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'acquiredAt') ||
      typeof parsed.token !== 'string' ||
      !FENCE_TOKEN.test(parsed.token) ||
      !isStrictUtcTimestamp(parsed.acquiredAt)
    ) {
      return null;
    }
    return { token: parsed.token, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function makeLeaseFenceMetadata(token: string, now: Date): LeaseFenceMetadata {
  return { token, acquiredAt: now.toISOString() };
}

function writeExclusiveLeaseFence(
  directoryPath: string,
  fileName: string,
  metadata: LeaseFenceMetadata,
): boolean {
  const markerPath = join(directoryPath, fileName);
  let descriptor: number | undefined;

  try {
    if (!isSafeDirectory(directoryPath)) return false;
    if (inspectPath(markerPath).kind !== 'missing') return false;
    if (!isSafeDirectory(directoryPath)) return false;
    descriptor = openSync(markerPath, 'wx');
    writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function releaseLeaseIfOwned(ownership: DeliveryLeaseOwnership): void {
  if (!isSafeDirectory(ownership.leasePath)) return;
  const metadata = readLeaseFenceFile(ownership.markerPath);
  if (!metadata || metadata.token !== ownership.token) return;
  if (!isSafeDirectory(ownership.leasePath)) return;
  if (!isSafeFile(ownership.markerPath)) return;
  if (inspectPath(ownership.releasedMarkerPath).kind !== 'missing') return;

  try {
    if (!isSafeDirectory(ownership.leasePath)) return;
    if (!isSafeFile(ownership.markerPath)) return;
    if (inspectPath(ownership.releasedMarkerPath).kind !== 'missing') return;
    renameSync(ownership.markerPath, ownership.releasedMarkerPath);
  } catch {
    // A stale owner must never mutate a replacement lock; failing closed is safe.
  }
}

function removeRecoveryClaimIfOwned(recoveryClaim: RecoveryClaim): void {
  const metadata = readRecoveryClaimDirectory(recoveryClaim.path);
  if (!metadata || metadata.token !== recoveryClaim.token) return;
  removeSafeDirectoryTree(recoveryClaim.path);
}

function renameSafeDirectory(
  sourcePath: string,
  destinationPath: string,
): boolean {
  if (!isSafeDirectory(sourcePath)) return false;
  if (inspectPath(destinationPath).kind !== 'missing') return false;

  try {
    if (!isSafeDirectory(sourcePath)) return false;
    if (inspectPath(destinationPath).kind !== 'missing') return false;
    renameSync(sourcePath, destinationPath);
    return true;
  } catch {
    return false;
  }
}

function inspectPath(path: string): PathInspection {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) return { kind: 'unsafe' };
    if (details.isFile()) return { kind: 'file' };
    if (details.isDirectory()) return { kind: 'directory' };
    return { kind: 'unsafe' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe' };
  }
}

function isSafeDirectory(path: string): boolean {
  return inspectPath(path).kind === 'directory';
}

function isSafeFile(path: string): boolean {
  return inspectPath(path).kind === 'file';
}

function readSafeDirectoryEntries(path: string): string[] | null {
  if (!isSafeDirectory(path)) return null;
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

function removeSafeDirectoryTree(path: string): boolean {
  const details = inspectPath(path);
  if (details.kind === 'missing') return true;
  if (details.kind !== 'directory') return false;

  const entries = readSafeDirectoryEntries(path);
  if (!entries) return false;
  for (const entryName of entries) {
    const entryPath = join(path, entryName);
    const entryDetails = inspectPath(entryPath);
    if (entryDetails.kind === 'file') {
      try {
        if (!isSafeFile(entryPath)) return false;
        unlinkSync(entryPath);
      } catch {
        return false;
      }
      continue;
    }
    if (entryDetails.kind === 'directory') {
      if (!removeSafeDirectoryTree(entryPath)) return false;
      continue;
    }
    return false;
  }

  try {
    if (!isSafeDirectory(path)) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}
