import {
  beginPurchaseReplicaSend,
  beginPurchaseReplicaUpdate,
  confirmPurchaseReplicaSend,
  confirmPurchaseReplicaUpdate,
  continueExpiredPurchaseReplica,
  newPurchaseReplica,
  planPurchaseReplica,
  purchaseReplicaUuid,
} from '../../server/modules/purchase-inventory/purchase-lifecycle-replica';

const identity = { appId: 'cli_test_app', batchId: 'purchase-batch-01', recipientOpenId: 'ou_user_1' };
const sentAtMs = Date.UTC(2026, 0, 1);
const receipt = (uuid: string, messageId: string) => ({ source: 'feishu_message_readback' as const, uuid, messageId, sentAtMs });
const fourteenDays = 14 * 24 * 60 * 60 * 1000;

describe('purchase lifecycle replica', () => {
  it('keeps a stable valid idempotency key for the same app, batch and recipient', () => {
    const uuid = purchaseReplicaUuid(identity);
    expect(uuid).toMatch(/^[a-z0-9_-]{1,50}$/);
    expect(purchaseReplicaUuid({ ...identity })).toBe(uuid);
    expect(purchaseReplicaUuid({ ...identity, recipientOpenId: 'ou_user_2' })).not.toBe(uuid);
    expect(purchaseReplicaUuid({ ...identity, batchId: 'purchase-batch-02' })).not.toBe(uuid);
    expect(purchaseReplicaUuid({ ...identity, appId: 'cli_other' })).not.toBe(uuid);
  });

  it('plans one send, persists the uncertain state, then binds the receipt to the same message', () => {
    const initial = newPurchaseReplica(identity);
    const uuid = purchaseReplicaUuid(identity);
    expect(planPurchaseReplica(identity, initial, 1, true, sentAtMs + 1)).toEqual({ action: 'send', uuid, revision: 1 });
    const pending = beginPurchaseReplicaSend(identity, initial, 1, true, sentAtMs + 1);
    expect(initial.state).toBe('unattempted');
    expect(planPurchaseReplica(identity, pending, 2, true, sentAtMs + 1)).toEqual({ action: 'reconcile', reason: 'send_unknown' });
    expect(() => beginPurchaseReplicaSend(identity, pending, 2, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_SEND_NOT_ALLOWED');
    expect(() => confirmPurchaseReplicaSend(identity, pending, receipt('wrong', 'om_first'))).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    expect(() => confirmPurchaseReplicaSend(identity, pending, receipt(uuid, 'wrong'))).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    expect(() => confirmPurchaseReplicaSend(identity, pending, { ...receipt(uuid, 'om_first'), sentAtMs: 0 })).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    const delivered = confirmPurchaseReplicaSend(identity, pending, receipt(uuid, 'om_first'));
    expect(delivered).toMatchObject({ state: 'delivered', messageId: 'om_first', appliedRevision: 1, pendingRevision: 0 });
    expect(() => confirmPurchaseReplicaSend(identity, delivered, receipt(uuid, 'om_second'))).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
  });

  it('updates only a newer revision of the original message and fences uncertain updates', () => {
    const initial = newPurchaseReplica(identity);
    const delivered = confirmPurchaseReplicaSend(identity, beginPurchaseReplicaSend(identity, initial, 2, true, sentAtMs + 1), receipt(initial.uuid, 'om_first'));
    expect(planPurchaseReplica(identity, delivered, 1, true, sentAtMs + 1)).toEqual({ action: 'none', reason: 'stale' });
    expect(planPurchaseReplica(identity, delivered, 2, true, sentAtMs + 1)).toEqual({ action: 'none', reason: 'current' });
    expect(planPurchaseReplica(identity, delivered, 3, true, sentAtMs + 1)).toEqual({ action: 'update', messageId: 'om_first', expectedRevision: 2, revision: 3 });
    expect(() => beginPurchaseReplicaUpdate(identity, delivered, 'om_other', 3, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_UPDATE_NOT_ALLOWED');
    const updating = beginPurchaseReplicaUpdate(identity, delivered, 'om_first', 3, true, sentAtMs + 1);
    expect(planPurchaseReplica(identity, updating, 4, true, sentAtMs + 1)).toEqual({ action: 'reconcile', reason: 'update_unknown' });
    expect(() => beginPurchaseReplicaUpdate(identity, updating, 'om_first', 4, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_UPDATE_NOT_ALLOWED');
    expect(() => confirmPurchaseReplicaUpdate(identity, updating, 'om_other', 3)).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    expect(() => confirmPurchaseReplicaUpdate(identity, updating, 'om_first', 4)).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    const updated = confirmPurchaseReplicaUpdate(identity, updating, 'om_first', 3);
    expect(updated).toMatchObject({ state: 'delivered', messageId: 'om_first', appliedRevision: 3, pendingRevision: 0 });
  });

  it('never plans a send or update for a recipient who is no longer authorized', () => {
    const initial = newPurchaseReplica(identity);
    expect(planPurchaseReplica(identity, initial, 1, false, sentAtMs + 1)).toEqual({ action: 'none', reason: 'unauthorized' });
    expect(() => beginPurchaseReplicaSend(identity, initial, 1, false, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_SEND_NOT_ALLOWED');
    const delivered = confirmPurchaseReplicaSend(identity, beginPurchaseReplicaSend(identity, initial, 1, true, sentAtMs + 1), receipt(initial.uuid, 'om_first'));
    expect(planPurchaseReplica(identity, delivered, 2, false, sentAtMs + 1)).toEqual({ action: 'none', reason: 'unauthorized' });
    expect(() => beginPurchaseReplicaUpdate(identity, delivered, 'om_first', 2, false, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_UPDATE_NOT_ALLOWED');
  });

  it('allows a linked new generation only after 14 days, using verified send and trusted current times', () => {
    const initial = newPurchaseReplica(identity);
    const pending = beginPurchaseReplicaSend(identity, initial, 4, true, sentAtMs + 1);
    const delivered = confirmPurchaseReplicaSend(identity, pending, receipt(initial.uuid, 'om_first'));
    expect(planPurchaseReplica(identity, delivered, 5, true, sentAtMs + fourteenDays)).toEqual({ action: 'update', messageId: 'om_first', expectedRevision: 4, revision: 5 });
    expect(planPurchaseReplica(identity, delivered, 5, true, sentAtMs + fourteenDays + 1)).toEqual({ action: 'continue', messageId: 'om_first', expectedRevision: 4, revision: 5 });
    expect(planPurchaseReplica(identity, delivered, 4, true, sentAtMs + fourteenDays + 1)).toEqual({ action: 'none', reason: 'current' });
    expect(planPurchaseReplica(identity, delivered, 5, false, sentAtMs + fourteenDays + 1)).toEqual({ action: 'none', reason: 'unauthorized' });
    expect(planPurchaseReplica(identity, pending, 5, true, sentAtMs + fourteenDays + 1)).toEqual({ action: 'reconcile', reason: 'send_unknown' });
    expect(() => beginPurchaseReplicaUpdate(identity, delivered, 'om_first', 5, true, sentAtMs + fourteenDays + 1)).toThrow('PURCHASE_REPLICA_UPDATE_NOT_ALLOWED');
    expect(() => planPurchaseReplica(identity, delivered, 5, true, sentAtMs - 1)).toThrow('PURCHASE_REPLICA_CLOCK_INVALID');
    expect(() => continueExpiredPurchaseReplica(identity, delivered, sentAtMs + fourteenDays, true)).toThrow('PURCHASE_REPLICA_CONTINUATION_NOT_ALLOWED');
    expect(() => continueExpiredPurchaseReplica(identity, delivered, sentAtMs + fourteenDays + 1, false)).toThrow('PURCHASE_REPLICA_CONTINUATION_NOT_ALLOWED');
    expect(() => continueExpiredPurchaseReplica(identity, pending, sentAtMs + fourteenDays + 1, true)).toThrow('PURCHASE_REPLICA_CONTINUATION_NOT_ALLOWED');
    expect(() => continueExpiredPurchaseReplica(identity, { ...delivered, sentAtMs: 0 }, sentAtMs + fourteenDays + 1, true)).toThrow('PURCHASE_REPLICA_STATE_INVALID');
    expect(() => continueExpiredPurchaseReplica(identity, { ...delivered, sentTimeSource: '' }, sentAtMs + fourteenDays + 1, true)).toThrow('PURCHASE_REPLICA_STATE_INVALID');
    const updating = beginPurchaseReplicaUpdate(identity, delivered, 'om_first', 5, true, sentAtMs + 1);
    expect(planPurchaseReplica(identity, updating, 6, true, sentAtMs + fourteenDays + 1)).toEqual({ action: 'reconcile', reason: 'update_unknown' });
    expect(() => continueExpiredPurchaseReplica(identity, updating, sentAtMs + fourteenDays + 1, true)).toThrow('PURCHASE_REPLICA_CONTINUATION_NOT_ALLOWED');
    const continued = continueExpiredPurchaseReplica(identity, delivered, sentAtMs + fourteenDays + 1, true);
    expect(continued).toMatchObject({ generation: 2, state: 'unattempted', predecessorMessageId: 'om_first', messageId: '', appliedRevision: 4 });
    expect(continued.uuid).not.toBe(initial.uuid);
    expect(continued.uuid).toBe(purchaseReplicaUuid(identity, 2));
    expect(planPurchaseReplica(identity, continued, 3, true, sentAtMs + 1)).toEqual({ action: 'none', reason: 'stale' });
    const secondPending = beginPurchaseReplicaSend(identity, continued, 4, true, sentAtMs + 1);
    expect(() => confirmPurchaseReplicaSend(identity, secondPending, receipt(continued.uuid, 'om_first'))).toThrow('PURCHASE_REPLICA_RECEIPT_INVALID');
    const second = confirmPurchaseReplicaSend(identity, secondPending, { ...receipt(continued.uuid, 'om_second'), sentAtMs: sentAtMs + fourteenDays + 1 });
    expect(second).toMatchObject({ generation: 2, messageId: 'om_second', predecessorMessageId: 'om_first', appliedRevision: 4 });
  });

  it('rejects forged identities, malformed state, invalid revisions and receipt identity changes', () => {
    const initial = newPurchaseReplica(identity);
    expect(() => planPurchaseReplica({ ...identity, recipientOpenId: 'ou_other' }, initial, 1, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_IDENTITY_MISMATCH');
    expect(() => newPurchaseReplica({ ...identity, batchId: 'x' })).toThrow('PURCHASE_REPLICA_IDENTITY_INVALID');
    expect(() => planPurchaseReplica(identity, initial, 0, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_REQUEST_INVALID');
    expect(() => planPurchaseReplica(identity, { ...initial, uuid: 'forged' }, 1, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_IDENTITY_MISMATCH');
    expect(() => planPurchaseReplica(identity, { ...initial, state: 'delivered', messageId: 'om_x' }, 1, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_STATE_INVALID');
    expect(() => planPurchaseReplica(identity, { ...initial, appliedRevision: NaN }, 1, true, sentAtMs + 1)).toThrow('PURCHASE_REPLICA_REVISION_INVALID');
  });
});
