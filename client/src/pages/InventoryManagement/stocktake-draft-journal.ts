import { isStocktakeDraftDirty } from './inventory-stocktake.logic';
import type { StocktakeLine } from '@shared/inventory-stocktake.interface';
import type { AccessPrincipal } from '@shared/access-control.interface';
import type { StocktakeLocalDraft } from './InventoryStocktakeRow';

export function stocktakeDraftJournalIdentity(principal: AccessPrincipal & {principalFingerprint?: string | null}): string {
  return JSON.stringify([principal.accountId || principal.principalFingerprint || '', principal.impersonation?.actorAccountId || '', principal.authorizationVersion ?? null, principal.role, principal.purchaseBuilding, principal.buildings || [], principal.specialties || [], principal.effectiveAuthorization || null, principal.personalRules || []]);
}
const PREFIX = 'inventory-stocktake-drafts:v1:';
function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(16);
}
function record(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function validDraft(value: unknown): value is StocktakeLocalDraft {
  if (!record(value) || typeof value.quantity !== 'string' || value.quantity.length > 100 ||
    typeof value.note !== 'string' || value.note.length > 1000 || typeof value.dirty !== 'boolean') return false;
  if (value.baseVersion !== undefined && (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0)) return false;
  if (value.person !== null && (!record(value.person) || typeof value.person.recordId !== 'string' || typeof value.person.openId !== 'string' || typeof value.person.name !== 'string')) return false;
  return value.retry === null || (record(value.retry) && typeof value.retry.signature === 'string' && record(value.retry.request) && typeof value.retry.request.clientMutationId === 'string' && Boolean(value.retry.request.clientMutationId));
}

function validDraftBinding(key: string, draft: StocktakeLocalDraft): boolean {
  if (!/^(sample|review):\d{4}-\d{2}:[^:]+:.+$/.test(key)) return false;
  if (!draft.retry) return true;
  try {
    const [mode, original] = JSON.parse(draft.retry.signature);
    const {clientMutationId, ...payload} = draft.retry.request;
    return ['draft', 'confirm', 'refresh-line'].includes(mode) &&
      JSON.stringify(original) === JSON.stringify(payload) &&
      key === `${payload.scope || 'sample'}:${payload.month}:${payload.building}:${payload.recordId}`;
  } catch { return false; }
}

function validBulkBinding(key: string, value: unknown): boolean {
  if (!/^bulk:review:\d{4}-\d{2}:[^:]+$/.test(key) || !record(value)) return false;
  if (value.retry !== null) {
    if (!record(value.retry) || !record(value.retry.request) || typeof value.retry.signature !== 'string') return false;
    const {clientMutationId, ...payload} = value.retry.request;
    if (typeof clientMutationId !== 'string' || !clientMutationId || !Number.isSafeInteger(payload.expectedVersion) || !Array.isArray(payload.lines) || !payload.lines.length || payload.scope !== 'review' ||
      key !== `bulk:review:${payload.month}:${payload.building}` || JSON.stringify(payload) !== value.retry.signature) return false;
  }
  if (value.accepted !== null) {
    if (!record(value.accepted) || typeof value.accepted.id !== 'string' || !value.accepted.id ||
      key !== `bulk:review:${value.accepted.month}:${value.accepted.building}` || !['queued','running','success','error'].includes(value.accepted.status)) return false;
  }
  return Boolean(value.retry || value.accepted);
}

/** One record per row: typing never rewrites all stocktake rows. No shared/global identity fallback. */
export class StocktakeDraftJournal extends Map<string, StocktakeLocalDraft> {
  private readonly errors = new Map<string, string>();
  private readonly blocked = new Map<string, string[]>();
  private readonly tasks = new Map<string, unknown>();
  private readonly owner: string;
  private readonly permission: string;
  private readonly prefix: string;
  private readonly storage: Storage | null;
  private readonly hasIdentity: boolean;
  constructor(principal: AccessPrincipal & { principalFingerprint?: string | null }, storage?: Storage | null) {
    super();
    this.hasIdentity = Boolean(principal.accountId || principal.principalFingerprint);
    this.owner = JSON.stringify([principal.accountId || principal.principalFingerprint || '', principal.impersonation?.actorAccountId || '']);
    this.permission = JSON.stringify([principal.authorizationVersion ?? null, principal.role, principal.purchaseBuilding, principal.buildings || [], principal.specialties || [], principal.effectiveAuthorization || null, principal.personalRules || []]);
    const ownerPrefix = PREFIX + encodeURIComponent(this.owner) + ':';
    this.prefix = ownerPrefix + hash(this.permission) + ':';
    try { this.storage = storage === undefined ? window.sessionStorage : storage; } catch { this.storage = null; }
    if (!this.storage || (!principal.accountId && !principal.principalFingerprint)) return;
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const storedKey = this.storage.key(index);
        if (!storedKey?.startsWith(ownerPrefix)) continue;
        try {
          const raw = JSON.parse(this.storage.getItem(storedKey) || 'null');
          if (!record(raw) || raw.version !== 1 || raw.owner !== this.owner || typeof raw.key !== 'string') throw new Error('invalid');
          if (raw.permission !== this.permission) {
            this.blocked.set(raw.key, [...(this.blocked.get(raw.key) || []), storedKey]);
            continue;
          }
          if (storedKey !== this.prefix + encodeURIComponent(raw.key)) throw new Error('invalid');
          if (raw.key.startsWith('bulk:') && validBulkBinding(raw.key, raw.value)) this.tasks.set(raw.key, raw.value);
          else if (validDraft(raw.value) && validDraftBinding(raw.key, raw.value)) super.set(raw.key, raw.value);
          else throw new Error('invalid');
        } catch { this.errors.set('*', '盘点恢复记录无法核验，原记录已保留，请联系管理员核对后继续'); }
      }
    } catch { this.errors.set('*', '本浏览器暂不能读取盘点草稿，请保留页面后重试'); }
  }
  issue(key: string): string {
    return this.errors.get('*') || this.errors.get(key) || (this.blocked.has(key) ? '该条盘点有权限变更前的未完成请求，请联系管理员核对；原记录已保留' : '');
  }
  recoveryBlocked(key: string): boolean { return this.errors.has('*') || this.blocked.has(key); }
  private write(key: string, value: unknown): void {
    if (this.recoveryBlocked(key)) return;
    try {
      if (!this.storage || !this.hasIdentity) throw new Error('no storage or identity');
      const text = JSON.stringify({ version: 1, owner: this.owner, permission: this.permission, key, value });
      if (text.length > 2_000_000) throw new Error('too large');
      const storedKey = this.prefix + encodeURIComponent(key);
      this.storage.setItem(storedKey, text);
      if (this.storage.getItem(storedKey) !== text) throw new Error('readback');
      this.errors.delete(key);
    } catch { this.errors.set(key, '盘点草稿未能安全保存到浏览器，请保留页面并重试；本次不会提交'); }
  }
  override set(key: string, value: StocktakeLocalDraft): this {
    if (!validDraft(value) || !validDraftBinding(key, value)) { this.errors.set(key, '盘点草稿格式无效，未提交'); return this; }
    this.write(key, value);
    super.set(key, value);
    return this;
  }
  override delete(key: string): boolean {
    if (this.recoveryBlocked(key)) return false;
    try {
      if (!this.storage) throw new Error('storage unavailable');
      const storedKey = this.prefix + encodeURIComponent(key);
      this.storage.removeItem(storedKey);
      if (this.storage.getItem(storedKey) !== null) throw new Error('remove readback failed');
      this.errors.delete(key);
    } catch { this.errors.set(key, '本地草稿未能清理，原内容已保留，请重试'); return false; }
    return super.delete(key);
  }
  canDiscardObsoleteDraft(key: string): boolean {
    const records = this.blocked.get(key);
    if (!records?.length || !this.storage || this.errors.has('*') || key.startsWith('bulk:')) return false;
    try { return records.every(storedKey => {
      const raw = JSON.parse(this.storage!.getItem(storedKey) || 'null');
      return raw?.owner === this.owner && raw.key === key && validDraft(raw.value) && raw.value.retry === null;
    }); } catch { return false; }
  }
  discardObsoleteDraft(key: string): boolean {
    if (!this.canDiscardObsoleteDraft(key)) return false;
    try {
      for (const storedKey of this.blocked.get(key) || []) {
        this.storage!.removeItem(storedKey);
        if (this.storage!.getItem(storedKey) !== null) return false;
      }
      this.blocked.delete(key); this.errors.delete(key); return true;
    } catch { return false; }
  }
  clearConfirmed(key: string): void {
    try {
      for (const stale of this.blocked.get(key) || []) this.storage?.removeItem(stale);
      this.blocked.delete(key);
    } catch { this.errors.set(key, '已确认结果的旧恢复记录清理失败，请刷新核对'); return; }
    this.delete(key);
  }
  saveTask(key: string, value: unknown): void {
    if (!validBulkBinding(key, value)) { this.errors.set(key, '原批量盘点请求格式无法核验，已保留原记录'); return; }
    this.write(key, value); this.tasks.set(key, value);
  }
  readTask<T>(key: string): T | null { return this.issue(key) ? null : (this.tasks.get(key) as T) || null; }
  deleteTask(key: string): void { this.delete(key); this.tasks.delete(key); }
  assertSaved(key: string): void {
    const error = this.issue(key);
    if (error) throw new Error(error);
    if (!this.storage) throw new Error('盘点请求无法安全保存，本次未提交');
  }
}

export function prepareStocktakeLineRetry(
  mode: 'draft' | 'confirm' | 'refresh-line',
  payload: Omit<import('@shared/inventory-stocktake.interface').StocktakeLineRequest, 'clientMutationId'>,
  pending: StocktakeLocalDraft['retry'],
  newId: () => string,
): NonNullable<StocktakeLocalDraft['retry']> {
  if (pending) return pending;
  return {signature: JSON.stringify([mode, payload]), request: {...payload, clientMutationId: newId()}};
}

/** Explicitly settle the persisted request; a stock refresh need not change any input state. */
export function settleStocktakeLineDraft(
  drafts: Map<string, StocktakeLocalDraft>, key: string, line: StocktakeLine,
  values: Pick<StocktakeLocalDraft, 'quantity' | 'person' | 'note'>,
): void {
  if (line.status === 'confirmed') {
    if (drafts instanceof StocktakeDraftJournal) drafts.clearConfirmed(key);
    else drafts.delete(key);
    return;
  }
  const dirty = isStocktakeDraftDirty(line, values);
  if (dirty) drafts.set(key, {...values, baseVersion: line.version, dirty, retry: null});
  else drafts.delete(key);
}

export function discardEditableStocktakeDraft(
  drafts: Map<string, StocktakeLocalDraft>, key: string, allowed: boolean,
): boolean {
  if (!allowed || drafts.get(key)?.retry || (drafts instanceof StocktakeDraftJournal && drafts.recoveryBlocked(key))) return false;
  drafts.delete(key);
  return !drafts.has(key) && !(drafts instanceof StocktakeDraftJournal && drafts.issue(key));
}
