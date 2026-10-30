import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive, type ProcessLockOwner } from '../process-lock-owner';
import { canonicalCardJson, isReadonlyDisplayCard, type SanitizedReadonlyCard } from './readonly-card';

export type MirrorState = 'pending' | 'sending' | 'delivered' | 'unknown' | 'failed' | 'suppressed';
export type MirrorOperationKind = 'create' | 'update' | 'recall';
export interface MirrorIdentity { appId: string; recipientOpenId: string; enabledAt?: string }
export interface MirrorGroup {
  key: string; readonlyCard: Record<string, unknown>; fingerprint: string; revision: number; appliedRevision: number;
  sourceMessageIds: string[]; messageId: string; uuid: string; state: MirrorState;
  // terminal is legacy display metadata (no enabled controls), never a business-state gate.
  hasEnabledActions: boolean; terminal: boolean; nativeRecipient: boolean; recalled: boolean;
  createdAt: string; updatedAt: string; nextAttemptAt: string; attempts: number; lastErrorCode: string;
  claim?: { token: string; operation: MirrorOperationKind; revision: number; owner: ProcessLockOwner; startedAt: string; leaseUntil: string };
}
interface MirrorSource { groupKey: string; originalRecipientOpenId: string; nextSequence: number; appliedSequence: number; reservations: Record<string, number> }
export interface MirrorStoreSnapshot {
  schemaVersion: 1; appId: string; recipientOpenId: string; enabledAt: string; revision: number;
  groups: Record<string, MirrorGroup>; sources: Record<string, MirrorSource>;
}
export interface MirrorEnrollmentInput {
  sourceMessageId: string; groupKey: string; card: SanitizedReadonlyCard; originalRecipientOpenId?: string;
  now?: string | Date; sourceStartedAt?: string | Date;
}
export interface MirrorUpdateOperation { sourceMessageId: string; operationId: string; sequence: number }
export interface MirrorClaim {
  groupKey: string; token: string; operation: MirrorOperationKind; revision: number; card: Record<string, unknown>;
  messageId: string; uuid: string; appId: string; recipientOpenId: string; leaseUntil: string;
}
export interface MirrorFailure { unknown: boolean; retryAt?: string | Date; errorCode?: string }
export interface MirrorStoreOptions { maxGroups?: number; maxSources?: number; maxBytes?: number; leaseMs?: number }
export class MirrorStoreError extends Error { constructor(readonly code: string) { super('只读卡片副本台账暂不可用，原业务流程保持不变'); } }

/** Separate delivery state only. It cannot read or grant application permissions. */
export class FeishuCardMirrorStore {
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  private readonly defaults: Required<MirrorStoreOptions>;
  private readonly initialEnabledAt: string;
  constructor(readonly filePath: string, readonly identity: MirrorIdentity, options: MirrorStoreOptions = {}) {
    if (!/^cli_[A-Za-z0-9_-]{1,120}$/.test(identity.appId) || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(identity.recipientOpenId)) throw problem('IDENTITY_INVALID');
    ordinary(filePath);
    this.initialEnabledAt = timestamp(identity.enabledAt || new Date());
    this.defaults = { maxGroups: options.maxGroups ?? 20_000, maxSources: options.maxSources ?? 100_000, maxBytes: options.maxBytes ?? 32 * 1024 * 1024, leaseMs: options.leaseMs ?? 60_000 };
    if (Object.values(this.defaults).some(value => !Number.isSafeInteger(value) || value < 1) || this.defaults.leaseMs > 3_600_000) throw problem('LIMIT_INVALID');
  }
  read(): MirrorStoreSnapshot {
    try {
      ordinary(this.filePath);
      if (!existsSync(this.filePath)) {
        if (this.persisted) throw problem('LEDGER_MISSING');
        return { schemaVersion: 1, appId: this.identity.appId, recipientOpenId: this.identity.recipientOpenId, enabledAt: this.initialEnabledAt, revision: 0, groups: {}, sources: {} };
      }
      this.persisted = true;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.size > this.defaults.maxBytes) throw problem('LEDGER_SIZE');
      const state: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!validState(state)) throw problem('LEDGER_INVALID');
      if (state.appId !== this.identity.appId || state.recipientOpenId !== this.identity.recipientOpenId) throw problem('IDENTITY_MISMATCH');
      return state;
    } catch (error) { if (error instanceof MirrorStoreError) throw error; throw problem('LEDGER_UNAVAILABLE'); }
  }
  capacity(state = this.read()) {
    const groups = Object.keys(state.groups).length, sources = Object.keys(state.sources).length, bytes = Buffer.byteLength(JSON.stringify(state));
    const ratio = Math.max(groups / this.defaults.maxGroups, sources / this.defaults.maxSources, bytes / this.defaults.maxBytes);
    return { groups, sources, bytes, maxGroups: this.defaults.maxGroups, maxSources: this.defaults.maxSources, maxBytes: this.defaults.maxBytes, level: ratio >= 1 ? 'full' : ratio >= .8 ? 'warning' : 'normal' };
  }
  getBySource(sourceMessageId: string): MirrorGroup | null {
    const state = this.read(), source = own(state.sources, sourceMessageId);
    return source ? structuredClone(state.groups[source.groupKey]) : null;
  }
  isMirrorMessageId(messageId: string): boolean {
    if (!message(messageId)) return false;
    return Object.values(this.read().groups).some(group => group.messageId === messageId);
  }
  async enroll(input: MirrorEnrollmentInput): Promise<MirrorGroup | null> {
    if (!message(input.sourceMessageId) || typeof input.groupKey !== 'string' || !input.groupKey.trim() || input.groupKey.length > 1000 || /[\u0000-\u001f]/.test(input.groupKey) || input.originalRecipientOpenId !== undefined && !/^ou_[A-Za-z0-9_-]{1,124}$/.test(input.originalRecipientOpenId)) throw problem('ENROLLMENT_INVALID');
    checkCard(input.card);
    const now = timestamp(input.now || new Date()), started = timestamp(input.sourceStartedAt || now);
    return this.mutate(state => {
      if (Date.parse(started) < Date.parse(state.enabledAt)) return null;
      if (Object.values(state.groups).some(group => group.messageId === input.sourceMessageId)) throw problem('MIRROR_RECURSION');
      const source = own(state.sources, input.sourceMessageId);
      if (source) {
        if (source.originalRecipientOpenId && input.originalRecipientOpenId && source.originalRecipientOpenId !== input.originalRecipientOpenId) throw problem('SOURCE_IDENTITY_CHANGED');
        return state.groups[source.groupKey];
      }
      const key = digest([state.appId, state.recipientOpenId, input.groupKey]);
      let group = own(state.groups, key);
      if (!group) {
        group = { key, readonlyCard: structuredClone(input.card.card), fingerprint: input.card.fingerprint, revision: 1, appliedRevision: 0,
          sourceMessageIds: [], messageId: '', uuid: digest(['readonly-copy', state.appId, state.recipientOpenId, key]).slice(0, 32), state: 'pending',
          hasEnabledActions: input.card.hasEnabledActions, terminal: !input.card.hasEnabledActions, nativeRecipient: false, recalled: false,
          createdAt: now, updatedAt: now, nextAttemptAt: now, attempts: 0, lastErrorCode: '' };
        state.groups[key] = group;
      }
      // A later recipient's initial send must not replace an already updated mirror.
      group.sourceMessageIds.push(input.sourceMessageId);
      state.sources[input.sourceMessageId] = { groupKey: key, originalRecipientOpenId: input.originalRecipientOpenId || '', nextSequence: 0, appliedSequence: 0, reservations: {} };
      if (input.originalRecipientOpenId === state.recipientOpenId) markNative(group, now);
      return group;
    });
  }
  async reserveUpdate(sourceMessageId: string): Promise<MirrorUpdateOperation | null> {
    if (!message(sourceMessageId)) throw problem('SOURCE_INVALID');
    return this.mutate(state => {
      const source = own(state.sources, sourceMessageId);
      if (!source) return null;
      if (Object.keys(source.reservations).length >= 32) throw problem('SOURCE_UPDATE_CAPACITY');
      const peers = groupSources(state, source.groupKey);
      const sequence = peers.reduce((maximum, peer) => Math.max(maximum, peer.nextSequence, peer.appliedSequence), 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw problem('SOURCE_SEQUENCE_EXHAUSTED');
      const operationId = randomUUID(); source.nextSequence = sequence;
      source.reservations[operationId] = sequence;
      return { sourceMessageId, operationId, sequence };
    });
  }
  async cancelUpdate(operation: MirrorUpdateOperation): Promise<void> {
    await this.mutate(state => {
      const source = own(state.sources, operation.sourceMessageId);
      if (source && own(source.reservations, operation.operationId) === operation.sequence) delete source.reservations[operation.operationId];
    });
  }
  async applyUpdate(sourceMessageId: string, operation: MirrorUpdateOperation, card: SanitizedReadonlyCard, nowValue?: string | Date): Promise<MirrorGroup | null> {
    checkCard(card); const now = timestamp(nowValue || new Date());
    if (sourceMessageId !== operation.sourceMessageId || !message(sourceMessageId)) throw problem('UPDATE_INVALID');
    return this.mutate(state => {
      const source = own(state.sources, sourceMessageId);
      if (!source) return null;
      const group = state.groups[source.groupKey], sequence = own(source.reservations, operation.operationId);
      const peers = groupSources(state, source.groupKey), applied = peers.reduce((maximum, peer) => Math.max(maximum, peer.appliedSequence), 0);
      if (sequence === undefined) { if (operation.sequence <= applied) return group; throw problem('UPDATE_NOT_RESERVED'); }
      if (sequence !== operation.sequence) throw problem('UPDATE_NOT_RESERVED');
      delete source.reservations[operation.operationId];
      if (sequence <= applied) return group;
      source.appliedSequence = sequence;
      for (const peer of peers) for (const [token, old] of Object.entries(peer.reservations)) if (old <= sequence) delete peer.reservations[token];
      applyIncomingCard(group, card, now);
      return group;
    });
  }
  async suppressSource(sourceMessageId: string, nowValue?: string | Date): Promise<MirrorGroup | null> {
    const now = timestamp(nowValue || new Date());
    return this.mutate(state => { const source = own(state.sources, sourceMessageId); if (!source) return null; const group = state.groups[source.groupKey]; markNative(group, now); return group; });
  }
  /** groupKey is the persisted key returned by getBySource/enroll, not the enrollment grouping material. */
  async claimNext(nowValue?: string | Date, groupKey?: string): Promise<MirrorClaim | null> {
    const now = timestamp(nowValue || new Date());
    return this.mutate(state => {
      const group = Object.values(state.groups).filter(row => (groupKey === undefined || row.key === groupKey) && !row.claim && row.state !== 'unknown' && row.state !== 'failed' &&
        (row.nativeRecipient ? !!row.messageId && !row.recalled : row.state === 'pending') && Date.parse(row.nextAttemptAt) <= Date.parse(now))
        .sort((a,b) => a.updatedAt.localeCompare(b.updatedAt) || a.key.localeCompare(b.key))[0];
      if (!group) return null;
      const operation: MirrorOperationKind = group.nativeRecipient ? 'recall' : group.messageId ? 'update' : 'create';
      const token = randomUUID(), leaseUntil = new Date(Date.parse(now) + this.defaults.leaseMs).toISOString();
      group.claim = { token, operation, revision: group.revision, owner: createProcessLockOwner(token, new Date(now)), startedAt: now, leaseUntil };
      group.state = 'sending'; group.attempts++;
      return { groupKey: group.key, token, operation, revision: group.revision, card: structuredClone(group.readonlyCard), messageId: group.messageId,
        uuid: group.uuid, appId: state.appId, recipientOpenId: state.recipientOpenId, leaseUntil };
    });
  }
  async complete(claim: MirrorClaim, deliveredMessageId?: string, nowValue?: string | Date): Promise<boolean> {
    const now = timestamp(nowValue || new Date());
    return this.mutate(state => {
      const group = claimGroup(state, claim); if (!group) return false;
      if (claim.operation === 'create') {
        if (!message(deliveredMessageId) || Object.hasOwn(state.sources, deliveredMessageId)) throw problem('MIRROR_MESSAGE_INVALID');
        if (Object.values(state.groups).some(row => row.key !== group.key && row.messageId === deliveredMessageId)) throw problem('MIRROR_MESSAGE_COLLISION');
        group.messageId = deliveredMessageId;
      } else if (deliveredMessageId !== undefined && deliveredMessageId !== group.messageId) throw problem('MIRROR_MESSAGE_CHANGED');
      if (claim.operation === 'recall') group.recalled = true;
      else group.appliedRevision = Math.max(group.appliedRevision, claim.revision);
      delete group.claim; group.updatedAt = now; group.nextAttemptAt = now; group.lastErrorCode = '';
      group.state = group.nativeRecipient ? group.messageId && !group.recalled ? 'pending' : 'suppressed' : group.revision > group.appliedRevision ? 'pending' : 'delivered';
      return true;
    });
  }
  async fail(claim: MirrorClaim, failure: MirrorFailure, nowValue?: string | Date): Promise<boolean> {
    const now = timestamp(nowValue || new Date());
    if (!failure || typeof failure.unknown !== 'boolean' || failure.errorCode !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(failure.errorCode)) throw problem('FAILURE_INVALID');
    const retryAt = failure.retryAt ? timestamp(failure.retryAt) : undefined;
    return this.mutate(state => {
      const group = claimGroup(state, claim); if (!group) return false;
      delete group.claim; group.updatedAt = now; group.lastErrorCode = failure.errorCode || 'COPY_DELIVERY_FAILED';
      // Create outcome is not safe to repeat. PATCH/DELETE target an already known copy and are idempotent.
      group.state = failure.unknown && claim.operation === 'create' ? 'unknown' : retryAt ? 'pending' : 'failed';
      if (retryAt) group.nextAttemptAt = retryAt;
      return true;
    });
  }
  async recoverInterrupted(nowValue?: string | Date): Promise<number> {
    const now = timestamp(nowValue || new Date());
    return this.mutate(state => {
      let recovered = 0;
      for (const group of Object.values(state.groups)) if (group.claim && Date.parse(group.claim.leaseUntil) <= Date.parse(now) &&
        !processLockOwnerMayBeAlive(group.claim.owner, Date.parse(group.claim.startedAt))) {
        // Both expiry and a dead/replaced worker are required. A second live worker cannot steal delivery.
        const operation = group.claim.operation; delete group.claim;
        group.state = operation === 'create' ? 'unknown' : 'pending'; group.updatedAt = now; group.nextAttemptAt = now;
        group.lastErrorCode = 'INTERRUPTED_DELIVERY'; recovered++;
      }
      return recovered;
    });
  }
  private async mutate<T>(change: (state: MirrorStoreSnapshot) => T): Promise<T> {
    const operation = this.queue.then(() => {
      ordinary(this.filePath); mkdirSync(dirname(this.filePath), { recursive: true });
      const release = acquire(`${this.filePath}.lock`), temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const state = this.read(), before = JSON.stringify(state), result = change(state);
        if (JSON.stringify(state) === before) return structuredClone(result);
        state.revision++;
        if (!validState(state)) throw problem('WRITE_INVALID');
        const bytes = Buffer.from(JSON.stringify(state));
        if (Object.keys(state.groups).length > this.defaults.maxGroups || Object.keys(state.sources).length > this.defaults.maxSources || bytes.length > this.defaults.maxBytes) throw problem('LEDGER_CAPACITY');
        ordinary(this.filePath); const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, this.filePath); this.persisted = true;
        return structuredClone(result);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); release(); }
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
}

function markNative(group: MirrorGroup, now: string): void {
  group.nativeRecipient = true; group.updatedAt = now; group.nextAttemptAt = now;
  if (!group.claim && group.state !== 'unknown') group.state = group.messageId && !group.recalled ? 'pending' : 'suppressed';
}
function applyIncomingCard(group: MirrorGroup, card: SanitizedReadonlyCard, now: string): void {
  if (group.nativeRecipient) return;
  group.hasEnabledActions = card.hasEnabledActions; group.terminal = !card.hasEnabledActions;
  if (group.fingerprint === card.fingerprint) return;
  group.readonlyCard = structuredClone(card.card); group.fingerprint = card.fingerprint; group.revision++;
  group.updatedAt = now;
  if (group.state !== 'sending' && group.state !== 'unknown') { group.state = 'pending'; group.nextAttemptAt = now; }
}
function groupSources(state: MirrorStoreSnapshot, groupKey: string): MirrorSource[] {
  return state.groups[groupKey].sourceMessageIds.map(id => state.sources[id]);
}
function checkCard(card: SanitizedReadonlyCard): void {
  if (!card || !isReadonlyDisplayCard(card.card) || !hex(card.fingerprint) || digestCard(card.card) !== card.fingerprint || typeof card.hasEnabledActions !== 'boolean') throw problem('UNSAFE_CARD');
}
function claimGroup(state: MirrorStoreSnapshot, claim: MirrorClaim): MirrorGroup | undefined {
  if (claim.appId !== state.appId || claim.recipientOpenId !== state.recipientOpenId) throw problem('IDENTITY_MISMATCH');
  const group = own(state.groups, claim.groupKey);
  return group?.claim?.token === claim.token && group.claim.revision === claim.revision && group.claim.operation === claim.operation ? group : undefined;
}
function ordinary(file: string): void {
  if (!isAbsolute(file) || file.slice(parse(file).root.length).includes(':')) throw problem('PATH_INVALID');
  let cursor = resolve(file);
  while (true) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw problem('PATH_INVALID'); const parent = dirname(cursor); if (parent === cursor) return; cursor = parent; }
}
function lockOwner(file: string) { try { return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; } }
function acquire(file: string): () => void {
  ordinary(file); const owner = createProcessLockOwner(randomUUID()); let handle: number;
  try { handle = openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw problem('LOCK_UNAVAILABLE');
    const before = lockOwner(file);
    if (!before || processLockOwnerMayBeAlive(before, lstatSync(file).mtimeMs)) throw problem('LOCK_BUSY');
    const recovery = `${file}.recovery`; ordinary(recovery); let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { throw problem('LOCK_BUSY'); }
    try {
      const latest = lockOwner(file);
      if (!latest || latest.token !== before.token || processLockOwnerMayBeAlive(latest, lstatSync(file).mtimeMs)) throw problem('LOCK_BUSY');
      unlinkSync(file); handle = openSync(file, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
  try { writeFileSync(handle, JSON.stringify(owner)); fsyncSync(handle); } catch { closeSync(handle); unlinkSync(file); throw problem('LOCK_UNAVAILABLE'); }
  return () => { closeSync(handle); if (lockOwner(file)?.token === owner.token) unlinkSync(file); };
}
function timestamp(value: string | Date): string { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw problem('TIMESTAMP_INVALID'); return date.toISOString(); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function digestCard(value: unknown): string { return createHash('sha256').update(canonicalCardJson(value)).digest('hex'); }
function problem(code: string) { return new MirrorStoreError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = <T>(value: Record<string, T>, key: string): T | undefined => Object.hasOwn(value, key) ? value[key] : undefined;
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && Number(v) >= minimum;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const message = (v: unknown): v is string => typeof v === 'string' && /^om_[A-Za-z0-9_-]{1,160}$/.test(v);
const time = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
function validGroup(v: unknown): v is MirrorGroup {
  if (!object(v) || Object.keys(v).some(key => !['key','readonlyCard','fingerprint','revision','appliedRevision','sourceMessageIds','messageId','uuid','state','hasEnabledActions','terminal','nativeRecipient','recalled','createdAt','updatedAt','nextAttemptAt','attempts','lastErrorCode','claim'].includes(key)) ||
    !hex(v.key) || !isReadonlyDisplayCard(v.readonlyCard) || !hex(v.fingerprint) || digestCard(v.readonlyCard) !== v.fingerprint || !integer(v.revision,1) || !integer(v.appliedRevision) || Number(v.appliedRevision) > Number(v.revision) ||
    !Array.isArray(v.sourceMessageIds) || !v.sourceMessageIds.length || !v.sourceMessageIds.every(message) || new Set(v.sourceMessageIds).size !== v.sourceMessageIds.length || !(v.messageId === '' || message(v.messageId)) || typeof v.uuid !== 'string' || !/^[a-f0-9]{32}$/.test(v.uuid) ||
    !['pending','sending','delivered','unknown','failed','suppressed'].includes(String(v.state)) || ['hasEnabledActions','terminal','nativeRecipient','recalled'].some(key => typeof v[key] !== 'boolean') ||
    !time(v.createdAt) || !time(v.updatedAt) || !time(v.nextAttemptAt) || !integer(v.attempts) || typeof v.lastErrorCode !== 'string' || !/^[A-Za-z0-9_-]{0,80}$/.test(v.lastErrorCode)) return false;
  if (v.claim !== undefined && (!object(v.claim) || Object.keys(v.claim).sort().join(',') !== 'leaseUntil,operation,owner,revision,startedAt,token' ||
    typeof v.claim.token !== 'string' || !/^[a-f0-9-]{36}$/.test(v.claim.token) || !['create','update','recall'].includes(String(v.claim.operation)) ||
    !integer(v.claim.revision,1) || Number(v.claim.revision) > Number(v.revision) || !normalizeProcessLockOwner(v.claim.owner) || !time(v.claim.startedAt) || !time(v.claim.leaseUntil))) return false;
  return (v.state === 'sending') === (v.claim !== undefined) && (!v.recalled || v.nativeRecipient === true) && (v.state !== 'delivered' || !!v.messageId) && (v.state !== 'suppressed' || v.nativeRecipient === true);
}
function validState(v: unknown): v is MirrorStoreSnapshot {
  if (!object(v) || Object.keys(v).sort().join(',') !== 'appId,enabledAt,groups,recipientOpenId,revision,schemaVersion,sources' || v.schemaVersion !== 1 || typeof v.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,120}$/.test(v.appId) || typeof v.recipientOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(v.recipientOpenId) || !time(v.enabledAt) || !integer(v.revision) || !object(v.groups) || !object(v.sources)) return false;
  const groups = v.groups as Record<string, MirrorGroup>, sources = v.sources as Record<string, MirrorSource>;
  if (!Object.entries(groups).every(([key,group]) => validGroup(group) && group.key === key)) return false;
  if (!Object.entries(sources).every(([id,source]) => message(id) && object(source) && Object.keys(source).sort().join(',') === 'appliedSequence,groupKey,nextSequence,originalRecipientOpenId,reservations' &&
    typeof source.groupKey === 'string' && !!own(groups,source.groupKey) && groups[source.groupKey].sourceMessageIds.includes(id) && typeof source.originalRecipientOpenId === 'string' && (!source.originalRecipientOpenId || /^ou_[A-Za-z0-9_-]{1,124}$/.test(source.originalRecipientOpenId)) &&
    integer(source.nextSequence) && integer(source.appliedSequence) && source.appliedSequence <= source.nextSequence && object(source.reservations) && Object.keys(source.reservations).length <= 32 &&
    Object.entries(source.reservations).every(([token,seq]) => /^[a-f0-9-]{36}$/.test(token) && integer(seq,1) && seq > source.appliedSequence && seq <= source.nextSequence))) return false;
  return Object.values(groups).every(group => group.sourceMessageIds.every(id => own(sources,id)?.groupKey === group.key) && (!group.messageId || !Object.hasOwn(sources,group.messageId))) &&
    new Set(Object.values(groups).map(group=>group.messageId).filter(Boolean)).size === Object.values(groups).filter(group=>group.messageId).length;
}
