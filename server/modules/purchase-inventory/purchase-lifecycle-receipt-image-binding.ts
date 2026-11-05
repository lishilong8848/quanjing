import { createHash } from 'node:crypto';

/** Populated exclusively from an authenticated Feishu event transport, never from form fields. */
export interface VerifiedLifecycleReceiptImage {
  appId: string;
  eventId: string;
  actorOpenId: string;
  chatId: string;
  imageMessageId: string;
  imageKey: string;
  messageCreatedAtMs: number;
  senderType: 'user';
  chatType: 'p2p';
  messageType: 'image';
}

declare const verifiedImageBrand: unique symbol;
export type VerifiedLifecycleReceiptImageSnapshot = Readonly<VerifiedLifecycleReceiptImage> & { readonly [verifiedImageBrand]: true };
const verifiedSnapshots = new WeakSet<object>();

/** A server-owned intent read from the authoritative ledger under its business lock. */
export interface LifecycleReceiptImageIntent {
  id: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  approvalBatchId: string;
  executionRecordId: string;
  cardMessageId: string;
  cardRevision: number;
  materialType: 'receipt_photo' | 'invoice';
  flowVersion: 'lifecycle_v1';
  createdAtMs: number;
  expiresAtMs: number;
}

export interface LifecycleReceiptImageBinding {
  intent: LifecycleReceiptImageIntent;
  event: VerifiedLifecycleReceiptImage;
  /** The ledger must enforce uniqueness for both the event and the image message. */
  eventFingerprint: string;
  messageFingerprint: string;
  /** Store alongside both keys; a matching key with a different payload must be rejected. */
  payloadFingerprint: string;
}
export type LifecycleReceiptImageEventKeys = Omit<LifecycleReceiptImageBinding, 'intent'>;

const ID = /^[A-Za-z0-9_:-]{1,256}$/u;
const FEISHU_APP = /^cli_[A-Za-z0-9_-]{1,124}$/u;
const FEISHU_USER = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const FEISHU_CHAT = /^oc_[A-Za-z0-9_-]{1,252}$/u;
const FEISHU_MESSAGE = /^om_[A-Za-z0-9_-]{1,252}$/u;
const BATCH = /^[A-Za-z0-9_-]{8,160}$/u;
const RECORD = /^[A-Za-z0-9_-]{1,100}$/u;
const INTENT = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_WINDOW_MS = 10 * 60 * 1000;
const MIN_EPOCH_MS = 1_000_000_000_000;

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= MIN_EPOCH_MS;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function fingerprint(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function assertEvent(event: VerifiedLifecycleReceiptImage | null): asserts event is VerifiedLifecycleReceiptImage {
  if (!event || !matches(event.appId, FEISHU_APP) || !matches(event.eventId, ID) || !matches(event.actorOpenId, FEISHU_USER) ||
      !matches(event.chatId, FEISHU_CHAT) || !matches(event.imageMessageId, FEISHU_MESSAGE) || !matches(event.imageKey, ID) ||
      !validTime(event.messageCreatedAtMs) || event.senderType !== 'user' || event.chatType !== 'p2p' || event.messageType !== 'image') throw new Error('签收图片事件身份或时间不可核对');
}
function assertIntent(intent: LifecycleReceiptImageIntent): void {
  if (!intent || !matches(intent.id, INTENT) || !matches(intent.appId, FEISHU_APP) || !matches(intent.actorOpenId, FEISHU_USER) ||
      !matches(intent.chatId, FEISHU_CHAT) || !matches(intent.approvalBatchId, BATCH) || !matches(intent.executionRecordId, RECORD) ||
      !matches(intent.cardMessageId, FEISHU_MESSAGE) || !Number.isSafeInteger(intent.cardRevision) || intent.cardRevision < 1 ||
      (intent.materialType !== 'receipt_photo' && intent.materialType !== 'invoice') || intent.flowVersion !== 'lifecycle_v1' ||
      !validTime(intent.createdAtMs) || !validTime(intent.expiresAtMs) || intent.expiresAtMs <= intent.createdAtMs ||
      intent.expiresAtMs - intent.createdAtMs > MAX_WINDOW_MS) throw new Error('签收图片意向身份或时间不可核对');
}

/** This asynchronous step must run outside any workflow ledger lock. */
export function createLifecycleReceiptImageVerifier(
  verifyAuthenticatedEvent: (rawEvent: unknown) => Promise<VerifiedLifecycleReceiptImage | null>,
): { verify(rawEvent: unknown, effectiveAppId: string): Promise<VerifiedLifecycleReceiptImageSnapshot> } {
  if (typeof verifyAuthenticatedEvent !== 'function') throw new Error('签收图片可信验证器不可用');
  return {
    async verify(rawEvent, effectiveAppId) {
      const source = await verifyAuthenticatedEvent(rawEvent);
      assertEvent(source);
      // Copy only known primitive fields so later changes to the upstream event cannot change a claim.
      const event = { appId: source.appId, eventId: source.eventId, actorOpenId: source.actorOpenId, chatId: source.chatId,
        imageMessageId: source.imageMessageId, imageKey: source.imageKey, messageCreatedAtMs: source.messageCreatedAtMs,
        senderType: source.senderType, chatType: source.chatType, messageType: source.messageType };
      assertEvent(event);
      if (!matches(effectiveAppId, FEISHU_APP) || event.appId !== effectiveAppId) throw new Error('签收图片事件应用不可核对');
      const snapshot = Object.freeze(event) as VerifiedLifecycleReceiptImageSnapshot;
      verifiedSnapshots.add(snapshot);
      return snapshot;
    },
  };
}

/**
 * Call synchronously under the workflow ledger lock, after verify() completes. The caller must
 * provide every outstanding intent for the app and actor, then atomically reauthorize and claim.
 * The verifier must itself be bound to the authenticated Feishu transport. This function does
 * not authorize, persist, make external calls, or enable the feature.
 */
/** Verify process-local provenance before looking up idempotency keys. This does
 * not authorize an action or make an expired intent valid for a new event. */
export function extractVerifiedLifecycleReceiptImage(event: VerifiedLifecycleReceiptImageSnapshot, effectiveAppId: string): LifecycleReceiptImageEventKeys {
  if (!event || !verifiedSnapshots.has(event) || !Object.isFrozen(event)) throw new Error('签收图片事件未经可信验证');
  assertEvent(event);
  if (!matches(effectiveAppId, FEISHU_APP) || event.appId !== effectiveAppId) throw new Error('签收图片事件应用不可核对');
  return { event: { ...event },
    eventFingerprint: fingerprint(['lifecycle-receipt-event-v1', event.appId, event.eventId]),
    messageFingerprint: fingerprint(['lifecycle-receipt-message-v1', event.appId, event.imageMessageId]),
    payloadFingerprint: fingerprint(['lifecycle-receipt-payload-v1', event.appId, event.actorOpenId, event.chatId, event.imageMessageId, event.imageKey, event.messageCreatedAtMs, event.senderType, event.chatType, event.messageType]) };
}

export function matchVerifiedLifecycleReceiptImage(
  event: VerifiedLifecycleReceiptImageSnapshot,
  effectiveAppId: string,
  outstanding: readonly LifecycleReceiptImageIntent[],
  currentTime: number,
): LifecycleReceiptImageBinding {
  const extracted = extractVerifiedLifecycleReceiptImage(event, effectiveAppId);
  if (!validTime(currentTime) || event.messageCreatedAtMs > currentTime || !Array.isArray(outstanding) || outstanding.length > 1000) throw new Error('签收图片事件来源或时间不可核对');
  for (const intent of outstanding) assertIntent(intent);
  const candidates = outstanding.filter(intent => intent.appId === event.appId && intent.actorOpenId === event.actorOpenId && intent.expiresAtMs >= currentTime);
  if (candidates.length !== 1) throw new Error('签收图片意向不存在或存在多个候选，请重新选择');
  const intent = candidates[0]!;
  if (intent.chatId !== event.chatId || currentTime < intent.createdAtMs || event.messageCreatedAtMs < intent.createdAtMs || event.messageCreatedAtMs > intent.expiresAtMs) throw new Error('签收图片不属于当前意向');
  return {
    intent: { ...intent },
    ...extracted,
  };
}
