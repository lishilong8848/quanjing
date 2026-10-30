import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { FeishuCardCopyEngine, type CardCopyEngineOptions } from './card-copy.engine';
import { FeishuCardMirrorStore, type MirrorState } from './mirror.store';
import type { PrimaryCardDelivery } from './transport';

export interface StandaloneCardTargetProof {
  name: '李世龙'; openId: string; appId: string; active: true;
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
      return !!proof && proof.name === '李世龙' && proof.verified === true && proof.active === true &&
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
