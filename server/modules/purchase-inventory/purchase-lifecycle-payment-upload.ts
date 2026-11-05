import { createHash } from 'node:crypto';

/** All identity and record properties must be resolved on the server, never from the request body. */
export interface LifecyclePaymentUploadAuthority {
  session: { accountId: string; authorizationVersion: number; appId: string; openId: string; kind: 'feishu' | 'personnel-password'; shared: boolean; impersonated: boolean; active: boolean; requiresPasswordChange: boolean };
  origin: string;
  expectedOrigin: string;
  csrfVerified: boolean;
  currentAppId: string;
  target: { flowVersion: 'lifecycle_v1'; approvalBatchId: string; executionRecordId: string; purchaserOpenId: string; orderState: 'waiting' | 'processing' | 'completed'; messageId: string; generation: number; cardRevision: number; desiredRevision: number; replicaState: 'delivered' | 'unattempted' | 'send_unknown'; sentAtMs: number };
}

/** Digests and byte counts must be computed from the actual server-received files. */
export interface LifecyclePaymentUploadFile { sha256: string; size: number; name: string }
export type LifecyclePaymentUploadStatus = 'prepared' | 'dispatching' | 'uploaded' | 'committed' | 'manual_reconciliation' | 'cancelled';
export interface LifecyclePaymentUploadEntry {
  key: string;
  fingerprint: string;
  bindingFingerprint: string;
  fileCount: number;
  contentKeys: string[];
  status: LifecyclePaymentUploadStatus;
  attemptId?: string;
  tokens?: string[];
}
export interface LifecyclePaymentUploadRequest { requestId: string; files: readonly LifecyclePaymentUploadFile[] }
export type LifecyclePaymentUploadDecision = { kind: 'new' | 'start' | 'commit' | 'replay' | 'manual_reconciliation'; entry: LifecyclePaymentUploadEntry };

const APP = /^cli_[A-Za-z0-9_-]{1,124}$/u;
const OPEN = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE = /^om_[A-Za-z0-9_-]{1,252}$/u;
const BATCH = /^[A-Za-z0-9_-]{8,160}$/u;
const RECORD = /^[A-Za-z0-9_-]{1,100}$/u;
const ACCOUNT = /^[A-Za-z0-9_-]{1,256}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/u;
const DAY_MS = 86400_000;
const fail = (): never => { throw new Error('采购付款附件授权或请求无效'); };
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

function sameHttpsOrigin(value: unknown, expected: unknown): boolean {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  try {
    const request = new URL(value), configured = new URL(expected);
    return request.protocol === 'https:' && configured.protocol === 'https:' && request.origin === configured.origin &&
      !request.username && !request.password && !configured.username && !configured.password &&
      value === request.origin && configured.pathname === '/' && !configured.search && !configured.hash;
  } catch { return false; }
}

function validateAuthority(authority: LifecyclePaymentUploadAuthority, nowMs: number, reauthorize: (authority: Readonly<LifecyclePaymentUploadAuthority>) => void): string {
  const s = authority?.session, t = authority?.target;
  if (!s || !t || !matches(s.accountId, ACCOUNT) || !Number.isSafeInteger(s.authorizationVersion) || s.authorizationVersion < 0 ||
      !matches(s.appId, APP) || s.appId !== authority.currentAppId || !matches(s.openId, OPEN) ||
      (s.kind !== 'feishu' && s.kind !== 'personnel-password') || s.shared !== false || s.impersonated !== false || s.active !== true || s.requiresPasswordChange !== false ||
      !sameHttpsOrigin(authority.origin, authority.expectedOrigin) || authority.csrfVerified !== true ||
      t.flowVersion !== 'lifecycle_v1' || !matches(t.approvalBatchId, BATCH) || !matches(t.executionRecordId, RECORD) ||
      t.purchaserOpenId !== s.openId || t.orderState !== 'waiting' || !matches(t.messageId, MESSAGE) || t.replicaState !== 'delivered' ||
      !Number.isSafeInteger(t.generation) || t.generation < 1 || !Number.isSafeInteger(t.cardRevision) || t.cardRevision < 1 || t.desiredRevision !== t.cardRevision ||
      !Number.isSafeInteger(t.sentAtMs) || !Number.isSafeInteger(nowMs) || t.sentAtMs < 1 || nowMs < t.sentAtMs || nowMs - t.sentAtMs > 14 * DAY_MS || typeof reauthorize !== 'function') fail();
  // Must re-resolve active account, actual duty, record scope and purchase.order synchronously
  // while the caller holds the same ledger lock as its mutation.
  const result: unknown = reauthorize(structuredClone(authority));
  if (result !== undefined) {
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) void Promise.resolve(result).catch(() => undefined);
    fail();
  }
  return hash(['purchase-payment-binding-v1', s.accountId, s.authorizationVersion, s.appId, s.openId, t.approvalBatchId, t.executionRecordId, t.messageId, t.generation, t.cardRevision]);
}

function validateRequest(request: LifecyclePaymentUploadRequest): { keySeed: string; files: Array<{ sha256: string; size: number; name: string }> } {
  if (!request || !matches(request.requestId, UUID) || !Array.isArray(request.files) || request.files.length < 1 || request.files.length > 5) return fail();
  const identities = new Set<string>();
  const files = request.files.map(file => {
    if (!file || !matches(file.sha256, HASH) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 20 * 1024 * 1024 ||
      typeof file.name !== 'string' || !file.name.trim() || Array.from(file.name).length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(file.name)) return fail();
    const contentIdentity = `${file.sha256}:${file.size}`;
    if (identities.has(contentIdentity)) return fail();
    identities.add(contentIdentity);
    return { sha256: file.sha256, size: file.size, name: file.name.normalize('NFC') };
  });
  return { keySeed: request.requestId.toLowerCase(), files };
}

export function validateLifecyclePaymentUploadEntry(entry: LifecyclePaymentUploadEntry): void {
  if (!entry || !matches(entry.key, HASH) || !matches(entry.fingerprint, HASH) || !matches(entry.bindingFingerprint, HASH) || !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1 || entry.fileCount > 5 || !Array.isArray(entry.contentKeys) || entry.contentKeys.length !== entry.fileCount || entry.contentKeys.some(key => !matches(key, HASH)) || new Set(entry.contentKeys).size !== entry.fileCount ||
    !['prepared', 'dispatching', 'uploaded', 'committed', 'manual_reconciliation', 'cancelled'].includes(entry.status)) fail();
  if (entry.status === 'prepared' || entry.status === 'cancelled') {
    if (entry.attemptId !== undefined || entry.tokens !== undefined) fail();
  } else if (!matches(entry.attemptId, UUID)) fail();
  if (entry.status === 'uploaded' || entry.status === 'committed') {
    if (!Array.isArray(entry.tokens) || entry.tokens.length !== entry.fileCount || entry.tokens.some(token => !matches(token, TOKEN)) || new Set(entry.tokens).size !== entry.tokens.length) fail();
  } else if (entry.tokens !== undefined) fail();
}

/** Call under the workflow ledger lock. otherContentKeys must contain ALL other live or committed uploads for this record. */
export function planLifecyclePaymentUpload(authority: LifecyclePaymentUploadAuthority, request: LifecyclePaymentUploadRequest,
  existing: LifecyclePaymentUploadEntry | null, otherContentKeys: readonly string[], nowMs: number, reauthorize: (authority: Readonly<LifecyclePaymentUploadAuthority>) => void): LifecyclePaymentUploadDecision {
  const bindingFingerprint = validateAuthority(authority, nowMs, reauthorize);
  const parsed = validateRequest(request);
  const key = purchaseLifecyclePaymentRequestKey(authority.currentAppId, parsed.keySeed);
  const fingerprint = hash(['purchase-payment-files-v1', bindingFingerprint, parsed.files]);
  const contentKeys = parsed.files.map(file => hash(['purchase-payment-content-v1', authority.currentAppId, authority.target.approvalBatchId, authority.target.executionRecordId, file.sha256, file.size]));
  if (!Array.isArray(otherContentKeys) || otherContentKeys.some(contentKey => !matches(contentKey, HASH)) || contentKeys.some(contentKey => otherContentKeys.includes(contentKey))) fail();
  if (!existing) return { kind: 'new', entry: { key, fingerprint, bindingFingerprint, fileCount: parsed.files.length, contentKeys, status: 'prepared' } };
  validateLifecyclePaymentUploadEntry(existing);
  if (existing.key !== key || existing.fingerprint !== fingerprint || existing.bindingFingerprint !== bindingFingerprint || existing.fileCount !== parsed.files.length || JSON.stringify(existing.contentKeys) !== JSON.stringify(contentKeys)) fail();
  const entry = structuredClone(existing);
  if (entry.status === 'cancelled') fail();
  const kind = entry.status === 'prepared' ? 'start' : entry.status === 'uploaded' ? 'commit' : entry.status === 'committed' ? 'replay' : 'manual_reconciliation';
  return { kind, entry };
}

/** Server-only derivation for status and cancellation; never log the raw request ID. */
export function purchaseLifecyclePaymentRequestKey(appId: string, requestId: string): string {
  if (!matches(appId, APP) || !matches(requestId, UUID)) return fail();
  return hash(['purchase-payment-request-v1', appId, requestId.toLowerCase()]);
}

/** Persist dispatching before invoking the upload. A crash after this point requires reconciliation. */
export function beginLifecyclePaymentUpload(entry: LifecyclePaymentUploadEntry, attemptId: string): LifecyclePaymentUploadEntry {
  validateLifecyclePaymentUploadEntry(entry);
  if (entry.status !== 'prepared' || !matches(attemptId, UUID)) return fail();
  return { ...entry, status: 'dispatching', attemptId: attemptId.toLowerCase() };
}

/** Record confirmed transport results durably even if authorization changed; this does not attach files. */
export function recordLifecyclePaymentUpload(entry: LifecyclePaymentUploadEntry, attemptId: string, tokens: readonly string[]): LifecyclePaymentUploadEntry {
  validateLifecyclePaymentUploadEntry(entry);
  if (entry.status !== 'dispatching' || entry.attemptId !== attemptId.toLowerCase() || !Array.isArray(tokens) || tokens.length !== entry.fileCount || tokens.some(token => !matches(token, TOKEN)) || new Set(tokens).size !== tokens.length) return fail();
  return { ...entry, status: 'uploaded', tokens: [...tokens] };
}

export function markLifecyclePaymentUploadUncertain(entry: LifecyclePaymentUploadEntry, attemptId: string): LifecyclePaymentUploadEntry {
  validateLifecyclePaymentUploadEntry(entry);
  if (entry.status !== 'dispatching' || entry.attemptId !== attemptId.toLowerCase()) return fail();
  return { ...entry, status: 'manual_reconciliation' };
}

/** Reauthorize and persist the returned committed entry with attachment merge and refresh in ONE ledger write. */
export function commitLifecyclePaymentUpload(authority: LifecyclePaymentUploadAuthority, request: LifecyclePaymentUploadRequest,
  entry: LifecyclePaymentUploadEntry, otherContentKeys: readonly string[], nowMs: number, reauthorize: (authority: Readonly<LifecyclePaymentUploadAuthority>) => void): LifecyclePaymentUploadEntry {
  const decision = planLifecyclePaymentUpload(authority, request, entry, otherContentKeys, nowMs, reauthorize);
  if (decision.kind !== 'commit') return fail();
  return { ...decision.entry, status: 'committed' };
}
