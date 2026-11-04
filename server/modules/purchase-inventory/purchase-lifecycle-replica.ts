import { createHash } from 'node:crypto';

/** One logical purchase card has a separate private message for each recipient. */
export interface PurchaseReplicaIdentity {
  appId: string;
  batchId: string;
  recipientOpenId: string;
}

export type PurchaseReplica = PurchaseReplicaIdentity & {
  generation: number;
  uuid: string;
  state: 'unattempted' | 'send_unknown' | 'delivered' | 'update_unknown';
  messageId: string;
  predecessorMessageId: string;
  sentAtMs: number;
  sentTimeSource: '' | 'feishu_message_readback';
  appliedRevision: number;
  pendingRevision: number;
};

/** The caller must derive this evidence from authenticated Feishu message readback, never client input. */
export interface VerifiedPurchaseReplicaReceipt {
  source: 'feishu_message_readback';
  uuid: string;
  messageId: string;
  sentAtMs: number;
}

export type PurchaseReplicaPlan =
  | { action: 'none'; reason: 'unauthorized' | 'current' | 'stale' }
  | { action: 'reconcile'; reason: 'send_unknown' | 'update_unknown' }
  | { action: 'continue'; messageId: string; expectedRevision: number; revision: number }
  | { action: 'send'; uuid: string; revision: number }
  | { action: 'update'; messageId: string; expectedRevision: number; revision: number };

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/;

function validateIdentity(identity: PurchaseReplicaIdentity): void {
  if (!/^cli_[A-Za-z0-9_-]{1,124}$/.test(identity.appId) ||
    !ID.test(identity.batchId) || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(identity.recipientOpenId)) {
    throw new Error('PURCHASE_REPLICA_IDENTITY_INVALID');
  }
}

function revision(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

/** Feishu message UUID is stable per app, batch and recipient, independent of card content. */
export function purchaseReplicaUuid(identity: PurchaseReplicaIdentity, generation = 1): string {
  validateIdentity(identity);
  if (!revision(generation, 1)) throw new Error('PURCHASE_REPLICA_GENERATION_INVALID');
  return createHash('sha256').update(JSON.stringify([
    'purchase-lifecycle-replica-v1', identity.appId, identity.batchId, identity.recipientOpenId, generation,
  ])).digest('hex').slice(0, 32);
}

export function newPurchaseReplica(identity: PurchaseReplicaIdentity): PurchaseReplica {
  return { ...identity, generation: 1, uuid: purchaseReplicaUuid(identity), state: 'unattempted', messageId: '', predecessorMessageId: '', sentAtMs: 0, sentTimeSource: '', appliedRevision: 0, pendingRevision: 0 };
}

function validateReplica(identity: PurchaseReplicaIdentity, replica: PurchaseReplica): void {
  const uuid = purchaseReplicaUuid(identity, replica.generation);
  if (replica.appId !== identity.appId || replica.batchId !== identity.batchId ||
    replica.recipientOpenId !== identity.recipientOpenId || replica.uuid !== uuid) {
    throw new Error('PURCHASE_REPLICA_IDENTITY_MISMATCH');
  }
  if (!revision(replica.appliedRevision, 0) || !revision(replica.pendingRevision, 0) || !revision(replica.sentAtMs, 0)) {
    throw new Error('PURCHASE_REPLICA_REVISION_INVALID');
  }
  if (replica.generation === 1 ? !!replica.predecessorMessageId : !MESSAGE_ID.test(replica.predecessorMessageId)) {
    throw new Error('PURCHASE_REPLICA_PREDECESSOR_INVALID');
  }
  if (replica.generation > 1 && replica.appliedRevision === 0) throw new Error('PURCHASE_REPLICA_REVISION_INVALID');
  const valid = replica.state === 'unattempted'
    ? !replica.messageId && replica.sentAtMs === 0 && replica.sentTimeSource === '' && replica.pendingRevision === 0 && (replica.generation > 1 || replica.appliedRevision === 0)
    : replica.state === 'send_unknown'
      ? !replica.messageId && replica.sentAtMs === 0 && replica.sentTimeSource === '' && replica.pendingRevision > 0 && replica.pendingRevision >= replica.appliedRevision && (replica.generation > 1 || replica.appliedRevision === 0)
      : replica.state === 'delivered'
        ? MESSAGE_ID.test(replica.messageId) && replica.messageId !== replica.predecessorMessageId && replica.sentAtMs > 0 && replica.sentTimeSource === 'feishu_message_readback' && replica.appliedRevision > 0 && replica.pendingRevision === 0
        : replica.state === 'update_unknown' && MESSAGE_ID.test(replica.messageId) && replica.messageId !== replica.predecessorMessageId && replica.sentAtMs > 0 && replica.sentTimeSource === 'feishu_message_readback' && replica.appliedRevision > 0 && replica.pendingRevision > replica.appliedRevision;
  if (!valid) throw new Error('PURCHASE_REPLICA_STATE_INVALID');
}

/** Read-only planning; a caller must atomically persist the matching begin transition before dispatch. */
export function planPurchaseReplica(
  identity: PurchaseReplicaIdentity,
  replica: PurchaseReplica,
  targetRevision: number,
  authorized: boolean,
  trustedNowMs: number,
): PurchaseReplicaPlan {
  validateReplica(identity, replica);
  if (!revision(targetRevision, 1) || typeof authorized !== 'boolean' || !revision(trustedNowMs, 1)) throw new Error('PURCHASE_REPLICA_REQUEST_INVALID');
  if (!authorized) return { action: 'none', reason: 'unauthorized' };
  if (replica.state === 'send_unknown' || replica.state === 'update_unknown') return { action: 'reconcile', reason: replica.state };
  if (replica.state === 'unattempted') return targetRevision < replica.appliedRevision
    ? { action: 'none', reason: 'stale' }
    : { action: 'send', uuid: replica.uuid, revision: targetRevision };
  if (targetRevision === replica.appliedRevision) return { action: 'none', reason: 'current' };
  if (targetRevision < replica.appliedRevision) return { action: 'none', reason: 'stale' };
  if (trustedNowMs < replica.sentAtMs) throw new Error('PURCHASE_REPLICA_CLOCK_INVALID');
  if (trustedNowMs - replica.sentAtMs > 14 * 24 * 60 * 60 * 1000) {
    return { action: 'continue', messageId: replica.messageId, expectedRevision: replica.appliedRevision, revision: targetRevision };
  }
  return { action: 'update', messageId: replica.messageId, expectedRevision: replica.appliedRevision, revision: targetRevision };
}

/** Persist this result under the same lock as plan validation, before any network request. */
export function beginPurchaseReplicaSend(identity: PurchaseReplicaIdentity, replica: PurchaseReplica, targetRevision: number, authorized: boolean, trustedNowMs: number): PurchaseReplica {
  const plan = planPurchaseReplica(identity, replica, targetRevision, authorized, trustedNowMs);
  if (plan.action !== 'send') throw new Error('PURCHASE_REPLICA_SEND_NOT_ALLOWED');
  return { ...replica, state: 'send_unknown', pendingRevision: targetRevision };
}

/** Only call after a successful Feishu receipt or a definitive independent reconciliation. */
export function confirmPurchaseReplicaSend(identity: PurchaseReplicaIdentity, replica: PurchaseReplica, receipt: VerifiedPurchaseReplicaReceipt): PurchaseReplica {
  validateReplica(identity, replica);
  if (replica.state !== 'send_unknown' || receipt.source !== 'feishu_message_readback' || receipt.uuid !== replica.uuid ||
    !MESSAGE_ID.test(receipt.messageId) || receipt.messageId === replica.predecessorMessageId || !revision(receipt.sentAtMs, 1)) throw new Error('PURCHASE_REPLICA_RECEIPT_INVALID');
  return { ...replica, state: 'delivered', messageId: receipt.messageId, sentAtMs: receipt.sentAtMs, sentTimeSource: receipt.source, appliedRevision: replica.pendingRevision, pendingRevision: 0 };
}

/** A single in-flight update per message prevents stale updates racing newer ones. */
export function beginPurchaseReplicaUpdate(identity: PurchaseReplicaIdentity, replica: PurchaseReplica, messageId: string, targetRevision: number, authorized: boolean, trustedNowMs: number): PurchaseReplica {
  const plan = planPurchaseReplica(identity, replica, targetRevision, authorized, trustedNowMs);
  if (plan.action !== 'update' || plan.messageId !== messageId) throw new Error('PURCHASE_REPLICA_UPDATE_NOT_ALLOWED');
  return { ...replica, state: 'update_unknown', pendingRevision: targetRevision };
}

export function confirmPurchaseReplicaUpdate(identity: PurchaseReplicaIdentity, replica: PurchaseReplica, messageId: string, targetRevision: number): PurchaseReplica {
  validateReplica(identity, replica);
  if (replica.state !== 'update_unknown' || replica.messageId !== messageId || replica.pendingRevision !== targetRevision) throw new Error('PURCHASE_REPLICA_RECEIPT_INVALID');
  return { ...replica, state: 'delivered', appliedRevision: targetRevision, pendingRevision: 0 };
}

/** Only server-trusted current time and Feishu-verified send time may authorize continuation. */
export function continueExpiredPurchaseReplica(identity: PurchaseReplicaIdentity, replica: PurchaseReplica, trustedNowMs: number, authorized: boolean): PurchaseReplica {
  validateReplica(identity, replica);
  const lifetimeMs = 14 * 24 * 60 * 60 * 1000;
  if (authorized !== true || replica.state !== 'delivered' || !revision(trustedNowMs, 1) ||
    trustedNowMs <= replica.sentAtMs || trustedNowMs - replica.sentAtMs <= lifetimeMs || !Number.isSafeInteger(replica.generation + 1)) {
    throw new Error('PURCHASE_REPLICA_CONTINUATION_NOT_ALLOWED');
  }
  const generation = replica.generation + 1;
  return { ...replica, generation, uuid: purchaseReplicaUuid(identity, generation), state: 'unattempted',
    predecessorMessageId: replica.messageId, messageId: '', sentAtMs: 0, sentTimeSource: '', pendingRevision: 0 };
}
