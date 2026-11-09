jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string) => process.env[key] || '',
}));

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

describe('purchase staged card cutover', () => {
  const appId = 'cli_cutover';
  const batchId = 'purchase-application-stage-cutover';
  const manager = 'ou_manager';
  const observer = 'ou_observer';
  const recordId = 'rec_one';
  const now = Date.now() - 10_000;
  const authorize = () => {};
  let store: PurchaseWorkflowStore;
  let directory: string;
  let file: string;
  let previous: string | undefined;

  const identity = (recipientOpenId = manager) => ({ appId, batchId, recipientOpenId });
  const record: PurchaseWorkflowRecord = {
    recordId, status: '未开始（待审批）', approvalBatchId: batchId, requestCode: 'CG-TEST',
    itemName: '测试物品', building: 'H楼', requesterOpenId: 'ou_requester', requesterName: '申请人',
    purchaserOpenId: '', purchaserName: '', purchaseMethod: '', requestedQuantity: 1,
    actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false,
    purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null,
    receiptPhotoTokens: [], invoiceTokens: [],
  };
  async function deliver(recipient: string, messageId: string) {
    const delivery = await store.beginLifecycleDelivery(identity(recipient), now + 10, 1, 1, authorize);
    await store.markLifecycleDeliveryDispatched(identity(recipient), delivery.entry.attemptToken, authorize);
    await store.completeLifecycleDelivery(identity(recipient), delivery.entry.attemptToken, {
      kind: 'send', receipt: { source: 'feishu_message_readback', uuid: delivery.entry.replica.uuid, messageId, sentAtMs: now + 10 },
    });
  }
  const readLedger = async () => JSON.parse(await readFile(file, 'utf8'));

  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = appId;
    directory = await mkdtemp(join(tmpdir(), 'purchase-stage-cutover-'));
    file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    await store.registerManagerApprovalBatch({
      approvalBatchId: batchId, recipientOpenId: manager, requesterOpenId: record.requesterOpenId, recordIds: [recordId], flowVersion: 'lifecycle_v1',
    }, now, {
      appId, recipients: [{ openId: manager, fullView: false }, { openId: observer, fullView: true }],
      authorityTargets: [{ recordId, target: { building: 'H楼' } }], authorize,
    });
    const card = serializePurchaseManagerBatchApprovalCardContext({
      version: 3, approvalBatchId: batchId, requesterOpenId: record.requesterOpenId, requesterName: record.requesterName,
      building: 'H楼', requestCode: record.requestCode, expectedDeliveryAt: null, createdAt: null,
      items: [{ executionRecordId: recordId, title: record.itemName, specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }],
    });
    const task = (await store.takeNextManagerApprovalNotification(now + 5))!;
    await store.enrollLifecycleRecipientFromNotification(task.key, task.claimToken, authorize);
    await deliver(manager, 'om_original_manager');
    await deliver(observer, 'om_original_observer');
    await store.completeLifecycleStageNotification(task.key, task.claimToken, 1, card, authorize, now + 20);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previous;
  });

  it('reuses original approval message and keeps old receipts byte-identical across restart and replay', async () => {
    const before = await readLedger();
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    expect(candidate!.replicas.map(row => [row.messageId, row.managerApproval])).toEqual([
      ['om_original_manager', true], ['om_original_observer', false],
    ]);
    const input = { ...candidate!, records: [record], verifiedAt: now + 21 };
    const result = await store.transitionLifecycleBatchToStageCards(input, now + 23);
    expect(result).toMatchObject({ changed: true, batch: { approvalBatchId: batchId, flowVersion: 'legacy', state: 'active', messageId: 'om_original_manager' } });
    const after = await readLedger();
    expect(before.requiredRuntimeCapability).toBe('purchase-workflow-ledger-v1');
    expect(after.requiredRuntimeCapability).toBe('purchase-stage-cards-v1');
    expect(after.lifecycleOutbox).toEqual(before.lifecycleOutbox);
    expect(after.managerApprovalBatchActions).toEqual(before.managerApprovalBatchActions);
    expect(after.notifications.filter((row: { kind: string }) => row.kind === 'manager_batch_approval_requested')).toEqual(before.notifications);
    expect(after.notifications.filter((row: { kind: string }) => row.kind === 'manager_batch_approval_refresh')).toHaveLength(1);
    expect(await store.listLifecycleStageCardTransitionCandidates()).toEqual([]);
    expect(await store.listExpiredLifecycleContinuations(10, now + 15 * 86400_000)).toEqual([]);
    await expect(store.openManagerApprovalBatchRejectEditor({
      approvalBatchId: batchId, executionRecordId: recordId, actorOpenId: manager, messageId: 'om_original_manager',
      lifecycle: { appId, cardRevision: 1 },
    })).rejects.toThrow('不接受新版本凭据');
    await expect(store.openManagerApprovalBatchRejectEditor({
      approvalBatchId: batchId, executionRecordId: recordId, actorOpenId: manager, messageId: 'om_original_manager',
    }, now + 24, () => { throw new Error('当前权限已撤销'); })).rejects.toThrow('当前权限已撤销');

    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    expect(await store.transitionLifecycleBatchToStageCards(input, now + 25)).toMatchObject({ changed: false });
    expect(await store.listStageCardRetirementTargets()).toMatchObject([{ messageId: 'om_original_observer', appId }]);
    await expect(store.markStageCardReplicaRetired(batchId, appId, 'om_original_manager', now + 26)).rejects.toThrow('回执不匹配');
    await store.markStageCardReplicaRetired(batchId, appId, 'om_original_observer', now + 26);
    await store.markStageCardReplicaRetired(batchId, appId, 'om_original_observer', now + 27);
    expect(await store.listStageCardRetirementTargets()).toEqual([]);
    expect((await readLedger()).lifecycleOutbox).toEqual(before.lifecycleOutbox);
  });

  it('leaves ledger bytes unchanged when an authenticated source scope or replica changed', async () => {
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const before = await readFile(file);
    const input = { ...candidate!, records: [{ ...record, building: 'B楼' }], verifiedAt: now + 21 };
    await expect(store.transitionLifecycleBatchToStageCards(input, now + 23)).rejects.toThrow('业务进度不一致');
    await expect(store.transitionLifecycleBatchToStageCards({
      ...input, records: [record], replicas: candidate!.replicas.slice(1),
    }, now + 23)).rejects.toThrow('原卡回执不完整');
    expect(await readFile(file)).toEqual(before);
  });

  it('keeps a currently accepted approval on its original flow until the claim settles', async () => {
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const claimed = await store.claimManagerApprovalBatchPendingApproval({
      approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_original_manager', eventId: 'cutover-concurrent-event',
      choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 },
    }, now + 30, authorize);
    expect(claimed.claimed).toBe(true);
    const before = await readFile(file);
    await expect(store.transitionLifecycleBatchToStageCards({
      ...candidate!, batchRevision: claimed.batch.revision, records: [record], verifiedAt: now + 31,
    }, now + 33)).rejects.toThrow('在途处理');
    expect(await store.listLifecycleStageCardTransitionCandidates()).toEqual([]);
    expect(await readFile(file)).toEqual(before);
  });

  it('preserves approval already written and does not duplicate its separate order-stage task', async () => {
    const eventId = 'cutover-settled-approval';
    await store.claimManagerApprovalBatchPendingApproval({
      approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_original_manager', eventId,
      choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 },
    }, now + 30, authorize);
    const action = (await store.takeNextManagerApprovalBatchAction(now + 31))!;
    await store.completeManagerApprovalBatchActionRecord(action.key, action.claimToken, recordId, {
      purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' },
    }, now + 32);
    const warehouse = { businessEventId: 'warehouse-inbound:' + recordId, recordId, recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' as const };
    await store.enqueueNotifications([warehouse], now + 32);
    const undelivered = (await store.takeNextNotification(now + 32, 60000, ['warehouse_inbound']))!;
    await store.failNotification(undelivered.key, undelivered.claimToken, new Error('原通知尚未发送'), now + 32);
    const before = await readLedger();
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const verified = { ...record, status: '审批通过（待下单）', approvalActionId: eventId, approvalCompleted: true, purchaserOpenId: 'ou_buyer' };
    const changed = await store.transitionLifecycleBatchToStageCards({
      ...candidate!, records: [verified], verifiedAt: now + 33,
    }, now + 34);
    expect(changed.batch.items).toMatchObject([{ status: 'approved', actionEventId: eventId, purchaserOpenId: 'ou_buyer' }]);
    const after = await readLedger();
    const orderTasks = (data: typeof after) => data.notifications.filter((row: { kind: string }) => row.kind === 'manager_batch_purchase_assigned');
    expect(orderTasks(before)).toHaveLength(1);
    expect(orderTasks(after)).toEqual(orderTasks(before));
    expect(await store.pendingWarehouseStageRecipients(recordId)).toEqual([]);
    const [first] = await store.enqueueNotifications([warehouse], now + 35);
    const [again] = await store.enqueueNotifications([warehouse], now + 36);
    expect(first).toMatchObject({ enqueued: true, entry: { businessEventId: 'warehouse-inbound:' + recordId + ':stage-cards' } });
    expect(again).toMatchObject({ enqueued: false, entry: { key: first!.entry.key } });
  });

  it('archives a confirmed missing upstream manual record without creating a new action or order', async () => {
    const eventId = 'cutover-missing-source';
    await store.claimManagerApprovalBatchPendingApproval({
      approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_original_manager', eventId,
      choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 },
    }, now + 30, authorize);
    const action = (await store.takeNextManagerApprovalBatchAction(now + 31))!;
    await store.markManagerApprovalBatchActionRecordManual(action.key, action.claimToken, recordId, new Error('原记录待核对'), now + 32);
    const before = await readLedger();
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const changed = await store.transitionLifecycleBatchToStageCards({
      ...candidate!, records: [], missingRecordIds: [recordId], verifiedAt: now + 33,
    }, now + 34);
    expect(changed.batch.state).toBe('manual_reconciliation');
    expect(changed.batch.items).toMatchObject([{ status: 'manual_reconciliation', actionEventId: eventId }]);
    expect(changed.batch.stageCardTransition).toMatchObject({ missingRecordIds: [recordId], reopenedItems: [] });
    const after = await readLedger();
    expect(after.managerApprovalBatchActions).toEqual(before.managerApprovalBatchActions);
    expect(after.notifications.some((row: { kind: string }) => row.kind === 'manager_batch_purchase_assigned')).toBe(false);
  });

  it('reopens only a proven pre-write failure for a fresh human decision and keeps the old action receipt', async () => {
    const eventId = 'cutover-known-prewrite';
    await store.claimManagerApprovalBatchPendingApproval({
      approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_original_manager', eventId,
      choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 },
    }, now + 30, authorize);
    const action = (await store.takeNextManagerApprovalBatchAction(now + 31))!;
    await store.markManagerApprovalBatchActionRecordManual(
      action.key, action.claimToken, recordId, new Error('采购明细授权范围已变化，需要重新核对'), now + 32,
    );
    const before = await readLedger();
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const input = { ...candidate!, verifiedAt: now + 33 };
    await expect(store.transitionLifecycleBatchToStageCards({
      ...input, records: [{ ...record, approvalActionId: eventId }],
    }, now + 34)).rejects.toThrow('业务进度不一致');
    const changed = await store.transitionLifecycleBatchToStageCards({ ...input, records: [record] }, now + 34);
    expect(changed.batch.state).toBe('active');
    expect(changed.batch.items).toMatchObject([{ status: 'pending', actionEventId: '', actorOpenId: '', choice: '' }]);
    expect(changed.batch.stageCardTransition?.reopenedItems).toMatchObject([{ recordId, actionEventId: eventId, choice: 'comprehensive' }]);
    expect((await readLedger()).managerApprovalBatchActions).toEqual(before.managerApprovalBatchActions);
  });
});
