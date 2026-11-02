import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { FeishuCardCopyEngine, type CardCopyEngineOptions } from './card-copy.engine';
import { FeishuCardMirrorStore, type MirrorState } from './mirror.store';
import type { PrimaryCardDelivery } from './transport';

export interface StandaloneCardTargetProof {
  name: string; openId: string; appId: string; active: true;
  identityFingerprint: string; checkedAt: string; verified: true;
}
export interface StandaloneCardNoticeOptions {
  event: PrimaryCardDelivery;
  http: CardCopyEngineOptions['http'];
  accessToken: () => Promise<string>;
  /** A dedicated durable release-notice ledger, separate from application delivery state. */
  storePath: string;
  appId: string;
  targetProof: StandaloneCardTargetProof;
  now?: () => Date;
}
export interface StandaloneCardNoticeResult {
  status: MirrorState | 'skipped' | 'unavailable';
  sentConfirmed: boolean;
  sourceMessageId: string;
  copyMessageId?: string;
  reasonCode?: string;
}
export interface StandaloneCardNoticeTarget {
  storePath: string;
  targetProof: StandaloneCardTargetProof;
}
export interface StandaloneCardNoticesOptions extends Omit<StandaloneCardNoticeOptions, 'storePath' | 'targetProof'> {
  targets: readonly StandaloneCardNoticeTarget[];
}
export interface StandaloneCardRecipientNoticeResult extends StandaloneCardNoticeResult {
  recipientOpenId: string;
}

const MAX_PROOF_AGE_MS = 15 * 60_000;
const appPattern = /^cli_[A-Za-z0-9_-]{1,120}$/;
const personPattern = /^ou_[A-Za-z0-9_-]{1,124}$/;
const messagePattern = /^om_[A-Za-z0-9_-]+$/;

/** Explicit one-shot operation: no environment/configuration reads, registry or timers. */
export async function copyStandaloneCardNotice(options: StandaloneCardNoticeOptions): Promise<StandaloneCardNoticeResult> {
  const sourceMessageId = messagePattern.test(options?.event?.messageId || '') ? options.event.messageId : '';
  const skipped = (reasonCode: string): StandaloneCardNoticeResult => ({ status: 'skipped', sentConfirmed: false, sourceMessageId, reasonCode });
  let engine: FeishuCardCopyEngine | undefined;
  try {
    const now = options.now || (() => new Date());
    const event = options.event;
    if (!event || event.source !== 'release-notice' || !sourceMessageId || event.recipientType !== 'chat_id' ||
      !/^oc_[A-Za-z0-9_-]+$/.test(event.recipientId) || typeof event.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(event.uuid)) {
      return skipped('STANDALONE_SOURCE_INVALID');
    }
    if (!appPattern.test(options.appId) || typeof options.storePath !== 'string' || !isAbsolute(options.storePath) || typeof options.accessToken !== 'function') {
      return skipped('STANDALONE_CONFIGURATION_INVALID');
    }
    const proof = options.targetProof;
    const targetValid = () => {
      const current = now().getTime(), checked = Date.parse(proof?.checkedAt), started = Date.parse(event.startedAt);
      return !!proof && typeof proof.name === 'string' && proof.name.length > 0 && proof.name.length <= 120 &&
        proof.name.trim() === proof.name && !/[\u0000-\u001f\u007f]/u.test(proof.name) && proof.verified === true && proof.active === true &&
        proof.appId === options.appId && personPattern.test(proof.openId) &&
        proof.identityFingerprint === createHash('sha256').update(`${options.appId}\0${proof.openId}`).digest('hex') &&
        Number.isFinite(current) && Number.isFinite(checked) && Number.isFinite(started) &&
        checked <= started && started <= current && current - checked <= MAX_PROOF_AGE_MS;
    };
    if (!targetValid()) return skipped('STANDALONE_TARGET_PROOF_INVALID');
    // The primary message has already succeeded. Its verified pre-send boundary
    // permits initial enrollment even though this separate ledger is created later.
    const store = new FeishuCardMirrorStore(options.storePath, {
      appId: options.appId, recipientOpenId: proof.openId, enabledAt: proof.checkedAt,
    });
    let diagnostic = '';
    engine = new FeishuCardCopyEngine({ store, http: options.http, accessToken: options.accessToken,
      targetValid, diagnostic: code => { diagnostic = code; }, now });
    await engine.delivered(event);
    // Never flush older pending notices or any other publication phase.
    await engine.flushSource(sourceMessageId, 1);
    const group = store.getBySource(sourceMessageId);
    if (!group) return skipped(diagnostic || 'STANDALONE_EVENT_NOT_ENROLLED');
    return {
      status: group.state, sentConfirmed: group.state === 'delivered' && !!group.messageId,
      sourceMessageId, ...(group.messageId ? { copyMessageId: group.messageId } : {}),
      ...(group.lastErrorCode || diagnostic ? { reasonCode: group.lastErrorCode || diagnostic } : {}),
    };
  } catch {
    return { status: 'unavailable', sentConfirmed: false, sourceMessageId, reasonCode: 'STANDALONE_COPY_UNAVAILABLE' };
  } finally { engine?.stop(); }
}

/** Each recipient owns a separate durable ledger; a failed copy cannot replay a successful peer. */
export async function copyStandaloneCardNotices(options: StandaloneCardNoticesOptions): Promise<StandaloneCardRecipientNoticeResult[]> {
  if (!Array.isArray(options?.targets) || options.targets.length > 10) throw new Error('STANDALONE_TARGETS_INVALID');
  const pathKey = (file: string) => {
    if (typeof file !== 'string' || !isAbsolute(file)) return '';
    const absolute = resolve(file);
    if (process.platform === 'win32' && absolute.split(/[\\/]/u).some(part => /[ .]$/u.test(part))) return '';
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const grouped = new Map<string, StandaloneCardNoticeTarget[]>();
  for (const target of options.targets) {
    const id = typeof target?.targetProof?.openId === 'string' ? target.targetProof.openId : '';
    grouped.set(id, [...(grouped.get(id) || []), target]);
  }
  const owners = new Map<string, Set<string>>();
  for (const [id, targets] of grouped) for (const target of targets) {
    const file = pathKey(target?.storePath);
    if (file) owners.set(file, new Set([...(owners.get(file) || []), id]));
  }
  return Promise.all([...grouped].map(async ([recipientOpenId, targets]) => {
    const target = targets[0];
    const identity = (row: StandaloneCardNoticeTarget) => JSON.stringify([pathKey(row?.storePath), row?.targetProof?.name,
      row?.targetProof?.appId, row?.targetProof?.openId, row?.targetProof?.identityFingerprint,
      row?.targetProof?.active, row?.targetProof?.verified, row?.targetProof?.checkedAt]);
    const conflictingDuplicate = targets.some(row => identity(row) !== identity(target));
    const sharedLedger = targets.some(row => (owners.get(pathKey(row?.storePath))?.size || 0) > 1);
    const invalidPath = !pathKey(target?.storePath);
    if (conflictingDuplicate || sharedLedger || invalidPath) return {
      recipientOpenId, status: 'skipped' as const, sentConfirmed: false,
      sourceMessageId: messagePattern.test(options.event?.messageId || '') ? options.event.messageId : '',
      reasonCode: conflictingDuplicate ? 'STANDALONE_DUPLICATE_TARGET_CONFLICT' : sharedLedger ? 'STANDALONE_SHARED_LEDGER_REJECTED' : 'STANDALONE_CONFIGURATION_INVALID',
    };
    const result = await copyStandaloneCardNotice({ ...options, storePath: target?.storePath, targetProof: target?.targetProof });
    return { recipientOpenId, ...result };
  }));
}
