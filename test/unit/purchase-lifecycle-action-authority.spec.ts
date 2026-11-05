import { assertPurchaseLifecycleAction, type PurchaseLifecycleActionAuthority } from '../../server/modules/purchase-inventory/purchase-lifecycle-action-authority';
import { newPurchaseReplica, beginPurchaseReplicaSend, confirmPurchaseReplicaSend } from '../../server/modules/purchase-inventory/purchase-lifecycle-replica';

const appId = 'cli_test_app', batchId = 'purchase-batch-01', operatorOpenId = 'ou_manager', messageId = 'om_manager', recordId = 'rec_a';
const now = Date.UTC(2026, 10, 4), replicaIdentity = { appId, batchId, recipientOpenId: operatorOpenId };
const initial = newPurchaseReplica(replicaIdentity);
const replica = confirmPurchaseReplicaSend(replicaIdentity, beginPurchaseReplicaSend(replicaIdentity, initial, 1, true, now), { uuid: initial.uuid, messageId, sentAtMs: now, source: 'feishu_message_readback' });
function sample(action: 'approve' | 'order' | 'receive' | 'inbound' = 'approve'): PurchaseLifecycleActionAuthority {
  const status = { approve: '未开始（待审批）', order: '审批通过（待下单）', receive: '下单完成（待签收）', inbound: '物品签收（待入库）' }[action];
  return {
    appId,
    callback: { appId, batchId, recordId, operatorOpenId, messageId, action, cardRevision: 1 },
    replica: { ...replica }, replicaPurpose: 'business', trustedNowMs: now + 1,
    identity: { openId: operatorOpenId, active: true, principal: { role: 'admin', purchaseBuilding: null } },
    currentDuty: { managers: [operatorOpenId], purchasers: [operatorOpenId], warehouse: [operatorOpenId] },
    batch: { flowVersion: 'lifecycle_v1', approvalBatchId: batchId, state: 'active', requesterOpenId: operatorOpenId, recordIds: [recordId], managerDeliveries: [{recipientOpenId: operatorOpenId}], items: [{ executionRecordId: recordId, status: action === 'approve' ? 'pending' : 'approved', purchaserOpenId: operatorOpenId }] } as PurchaseLifecycleActionAuthority['batch'],
    record: { recordId, status, building: 'A楼', requesterOpenId: operatorOpenId, purchaserOpenId: operatorOpenId } as PurchaseLifecycleActionAuthority['record'],
  };
}

describe('purchase lifecycle callback authority', () => {
  it.each(['approve','order','receive','inbound'] as const)('allows only the current assigned %s action', action => {
    expect(() => assertPurchaseLifecycleAction(sample(action))).not.toThrow();
  });
  it('rejects foreign app, batch, recipient, message, record, revision and invalid delivery', () => {
    const mutations: Array<(x: PurchaseLifecycleActionAuthority) => void> = [
      x => { x.callback.appId = 'cli_other'; }, x => { x.callback.batchId = 'purchase-other'; },
      x => { x.callback.operatorOpenId = 'ou_other'; }, x => { x.callback.messageId = 'om_other'; },
      x => { x.callback.recordId = 'rec_other'; }, x => { x.callback.cardRevision = 2; },
      x => { x.replica.uuid = 'forged'; }, x => { x.replica.state = 'update_unknown'; },
      x => { x.replicaPurpose = 'observer'; }, x => { x.batch.recordIds.push(recordId); },
      x => { (x.batch as typeof x.batch & { flowVersion?: string }).flowVersion = 'legacy'; },
      x => { x.batch.items.push({ ...x.batch.items[0] }); },
    ];
    for (const mutate of mutations) { const x = sample(); mutate(x); expect(() => assertPurchaseLifecycleAction(x)).toThrow(); }
  });
  it('denies inactive or unverified identity, password-only access and revoked duty or business permission', () => {
    const variations: Array<(x: PurchaseLifecycleActionAuthority) => void> = [
      x => { x.identity.active = false; }, x => { x.identity.openId = 'ou_other'; }, x => { x.identity.principal = null; },
      x => { x.identity.principal!.requiresPasswordChange = true; }, x => { x.currentDuty = null; },
      x => { x.currentDuty!.managers = []; }, x => { x.batch.managerDeliveries = []; },
      x => { x.identity.principal = { role: 'guest', purchaseBuilding: null }; },
    ];
    for (const mutate of variations) { const x = sample(); mutate(x); expect(() => assertPurchaseLifecycleAction(x)).toThrow(); }
  });
  it('rejects a changed stage, decided item, cross-building target and unauthorized actors', () => {
    for (const action of ['approve','order','receive','inbound'] as const) {
      const x = sample(action); x.record.status = '采购完成（已入库）'; expect(() => assertPurchaseLifecycleAction(x)).toThrow();
    }
    const wrongItem = sample('order'); wrongItem.batch.items[0].purchaserOpenId = 'ou_other'; expect(() => assertPurchaseLifecycleAction(wrongItem)).toThrow();
    const wrongRequester = sample('receive'); wrongRequester.record.requesterOpenId = 'ou_other'; expect(() => assertPurchaseLifecycleAction(wrongRequester)).toThrow();
    const wrongDuty = sample('inbound'); wrongDuty.currentDuty!.warehouse = []; expect(() => assertPurchaseLifecycleAction(wrongDuty)).toThrow();
    const wrongBuilding = sample('order'); wrongBuilding.batch.items[0].authorityTarget = { building: 'B楼' }; expect(() => assertPurchaseLifecycleAction(wrongBuilding)).toThrow();
  });
  it('rejects expired messages or an inconsistent server clock', () => {
    const expired = sample(); expired.trustedNowMs = now + 14 * 86400_000 + 1; expect(() => assertPurchaseLifecycleAction(expired)).toThrow();
    const earlier = sample(); earlier.trustedNowMs = now - 1; expect(() => assertPurchaseLifecycleAction(earlier)).toThrow();
  });
});
