jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string) => process.env[key] || '',
}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { webReceiptFingerprint, webReceiptHash, type PurchaseWebReceiptCommand } from '../../server/modules/purchase-inventory/purchase-web-receipt-command';
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
  async function restartStore() {
    await store.onModuleDestroy();
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
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
    const verified = { ...record, status: '审批通过（待下单）', approvalActionId: eventId, approvalCompleted: false,
      approvalSource: '程序卡片', approvalWorkflowStatus: '已通过', warehouseConfirmed: true, purchaserOpenId: 'ou_buyer' };
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

  it('recovers the exact unattempted order card for an authorized assigned requester and derives the stage authority at claim', async () => {
    const eventId = 'cutover-order-card-recovery';
    const purchaser = record.requesterOpenId;
    await store.claimManagerApprovalBatchPendingApproval({ approvalBatchId: batchId, actorOpenId: manager,
      messageId: 'om_original_manager', eventId, choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 } }, now + 30, authorize);
    const approval = (await store.takeNextManagerApprovalBatchAction(now + 31))!;
    await store.completeManagerApprovalBatchActionRecord(approval.key, approval.claimToken, recordId, {
      purchaserOpenId: purchaser, purchaserName: '指定采购人', authorityTarget: { building: 'H楼' },
    }, now + 32);
    const source = { ...record, status: '审批通过（待下单）', approvalActionId: eventId, approvalSource: '程序卡片',
      approvalWorkflowStatus: '已通过', warehouseConfirmed: true, purchaserOpenId: purchaser };
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const transition = await store.transitionLifecycleBatchToStageCards({ ...candidate!, records: [source], verifiedAt: now + 33 }, now + 34);
    // The fixture's old unattempted lifecycle stage task is separate from this canonical converted-batch task.
    const [existing] = await store.listNotifications({ kind: 'manager_batch_purchase_assigned' });
    const historical = await readLedger();
    const persisted = historical.notifications.find((row: { key: string }) => row.key === existing!.key);
    expect(persisted).toBeDefined();
    const canonicalEvent = `manager_batch_purchase_assigned:${batchId}:${transition.batch.revision}`;
    // Replace only this isolated fixture's unsent old task with the canonical task from the production shape.
    if (persisted.businessEventId !== canonicalEvent) {
      historical.notifications = historical.notifications.filter((row: { key: string }) => row.key !== existing!.key);
      await writeFile(file, JSON.stringify(historical));
      await store.enqueueNotifications([{ businessEventId: canonicalEvent, kind: 'manager_batch_purchase_assigned',
        recordId, recipientOpenId: purchaser, cardContext: transition.batch.cardContext }], now + 34);
    }
    const dutyError = new Error('当前采购岗位已变化，请使用现任人员的新卡片办理');
    const takeOrderTask = async (timestamp: number) => {
      let task = await store.takeNextManagerApprovalNotification(timestamp, 60_000);
      while (task && task.kind !== 'manager_batch_purchase_assigned') {
        await store.completeNotification(task.key, task.claimToken, {}, timestamp);
        task = await store.takeNextManagerApprovalNotification(timestamp, 60_000);
      }
      return task!;
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const task = await takeOrderTask(now + 35 + attempt);
      expect(task.attempts).toBe(attempt);
      if (attempt < 5) await store.rescheduleNotification(task.key, task.claimToken, dutyError, now + 36 + attempt, now + 35 + attempt);
      else await store.failNotification(task.key, task.claimToken, dutyError, now + 35 + attempt);
    }
    const [failed] = await store.listNotifications({ kind: 'manager_batch_purchase_assigned' });
    expect(failed).toMatchObject({ status: 'failed', sendOutcome: 'unattempted', attempts: 5, messageId: '', deliveryAudit: [] });
    let sourceResult = source, allowed = false;
    const gateway = { getExecutionRecordAsApp: jest.fn(async () => sourceResult), sendInteractiveCard: jest.fn().mockResolvedValue('om_separate_order') };
    const config = { canUseFeishuBusinessIdentity: () => true, feishuPrincipal: () => ({ role: allowed ? 'admin' : 'guest' }),
      currentDutyRoutePeople: () => null };
    const service = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, config as never);
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    const recoveryTime = new Date(now + 50);
    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    expect(await store.getNotification(failed!.key)).toEqual(failed);
    allowed = true;
    sourceResult = { ...source, status: '下单完成（待签收）' };
    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    expect(await store.getNotification(failed!.key)).toEqual(failed);
    sourceResult = { ...source, purchaserOpenId: 'ou_other' };
    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    expect(await store.getNotification(failed!.key)).toEqual(failed);
    sourceResult = source;

    const original = await readLedger();
    const uncertain = structuredClone(original);
    const uncertainTask = uncertain.notifications.find((row: { key: string }) => row.key === failed!.key);
    uncertainTask.sendOutcome = 'unknown';
    uncertainTask.firstSendAttemptAt = recoveryTime.toISOString();
    await writeFile(file, JSON.stringify(uncertain));
    expect(await store.requeueFailedMigratedOrderCard(failed!, batchId, recoveryTime, authorize)).toBe(false);
    expect(await readLedger()).toEqual(uncertain);
    await writeFile(file, JSON.stringify(original));

    await store.enqueueNotifications([{ businessEventId: 'existing-separate-stage-card', kind: 'manager_batch_purchase_assigned',
      recordId, recipientOpenId: purchaser, cardContext: transition.batch.cardContext }], now + 45);
    expect(await store.requeueFailedMigratedOrderCard(failed!, batchId, recoveryTime, authorize)).toBe(false);
    expect(await store.getNotification(failed!.key)).toEqual(failed);
    await writeFile(file, JSON.stringify(original));

    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    expect(await store.getNotification(failed!.key)).toMatchObject({ status: 'pending', attempts: 5, deliveryUuid: failed!.deliveryUuid });
    const claim = await takeOrderTask(now + 51);
    expect(claim).toMatchObject({ key: failed!.key, attempts: 6, deliveryUuid: failed!.deliveryUuid });
    const process = service as unknown as {
      processPurchaseBatchFulfillmentNotification(entry: typeof claim, now: Date, result: object): Promise<boolean>;
    };
    await expect(process.processPurchaseBatchFulfillmentNotification(claim, new Date(now + 52), { errors: [], alerts: [], failed: 0 })).resolves.toBe(true);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(purchaser, expect.any(Object), failed!.deliveryUuid);
    await service.requeueFailedMigratedOrderCards(appId, recoveryTime);
    expect(await store.listNotifications({ kind: 'manager_batch_purchase_assigned' })).toMatchObject([{
      key: failed!.key, status: 'completed', sendOutcome: 'delivered', attempts: 6, messageId: 'om_separate_order', deliveryUuid: failed!.deliveryUuid,
    }]);

    const click = { kind: 'purchase_batch_fulfillment_action' as const, action: 'submit_order' as const, approvalBatchId: batchId,
      executionRecordId: recordId, operatorOpenId: purchaser, messageId: 'om_separate_order', eventId: 'order-click-stage', actualQuantity: 1, actualAmount: 10, note: '' };
    await expect(service.handlePurchaseBatchFulfillmentCardAction({ ...click, operatorOpenId: 'ou_other' })).rejects.toThrow();
    await expect(service.handlePurchaseBatchFulfillmentCardAction({ ...click, lifecycle: { cardRevision: 1 } })).rejects.toThrow();
    await expect(service.handlePurchaseBatchFulfillmentCardAction(click)).resolves.toMatchObject({ claimed: true });
    const order = (await store.takeNextManagerApprovalNotification(Date.now() + 100, 60_000))!;
    expect(order.kind).toBe('manager_batch_order_command');
    const proof = await store.readAcceptedFulfillmentCommand({ notificationKey: order.key, claimToken: order.claimToken }, recordId, 'order', purchaser);
    expect(proof.proof.lifecycleAuthority).toMatchObject({ stageCards: true, actorOpenId: purchaser, choice: 'comprehensive' });
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

  it('quarantines a pending row whose source displays ordering without approval or purchaser evidence', async () => {
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const before = await readLedger();
    const ordering = { ...record, status: '审批通过（待下单）' };
    const input = { ...candidate!, verifiedAt: now + 31 };
    await expect(store.transitionLifecycleBatchToStageCards({
      ...input, records: [{ ...ordering, warehouseConfirmed: true }],
    }, now + 32)).rejects.toThrow('业务进度不一致');
    const changed = await store.transitionLifecycleBatchToStageCards({ ...input, records: [ordering] }, now + 32);
    expect(changed.batch.state).toBe('manual_reconciliation');
    expect(changed.batch.items).toMatchObject([{ status: 'manual_reconciliation', actionEventId: '', purchaserOpenId: '' }]);
    expect(changed.batch.stageCardTransition?.heldSourceItems).toEqual([{ recordId, reason: 'ordering_without_approval_receipt' }]);
    const after = await readLedger();
    expect(after.managerApprovalBatchActions).toEqual(before.managerApprovalBatchActions);
    expect(after.notifications.some((row: { kind: string }) => row.kind === 'manager_batch_purchase_assigned')).toBe(false);
    const checkReadback = async () => {
      expect(await store.findManagerApprovalBatch(batchId)).toMatchObject({
        flowVersion: 'legacy', state: 'manual_reconciliation',
        items: [{ executionRecordId: recordId, status: 'manual_reconciliation', choice: '', actionEventId: '' }],
      });
      expect(await store.listLifecycleStageCardTransitionCandidates()).toEqual([]);
    };
    await checkReadback();
    await restartStore();
    await checkReadback();
    await restartStore();
    await checkReadback();

    const falseChoice = structuredClone(after);
    falseChoice.managerApprovalBatches[0].items[0].actionEventId = 'unaudited-decision';
    await writeFile(file, JSON.stringify(falseChoice));
    await expect(store.findManagerApprovalBatch(batchId)).rejects.toThrow('采购分阶段批次账本损坏');
    delete after.managerApprovalBatches[0].stageCardTransition.heldSourceItems;
    await writeFile(file, JSON.stringify(after));
    await expect(store.findManagerApprovalBatch(batchId)).rejects.toThrow('采购分阶段批次账本损坏');
  });

  it('changes only the presentation of a final receipt while preserving an ambiguous original order', async () => {
    const eventId = 'cutover-terminal-order';
    await store.claimManagerApprovalBatchPendingApproval({
      approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_original_manager', eventId,
      choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 },
    }, now + 30, authorize);
    const action = (await store.takeNextManagerApprovalBatchAction(now + 31))!;
    await store.completeManagerApprovalBatchActionRecord(action.key, action.claimToken, recordId, {
      purchaserOpenId: 'ou_buyer', purchaserName: '采购员', authorityTarget: { building: 'H楼' },
    }, now + 32);
    const [candidate] = await store.listLifecycleStageCardTransitionCandidates();
    const platformIdentity: PurchasePlatformIdentityProof = {
      source: 'platform', actorAccountId: 'person', actorDisplayName: '办理人', actorAuthorizationVersion: 1,
      subjectAccountId: 'person', subjectDisplayName: '办理人', subjectAuthorizationVersion: 1,
      sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: now + 1_000_000,
    };
    const args = {
      recordId, fingerprint: 'a'.repeat(64), expectedResultFingerprint: 'b'.repeat(64),
      actorOpenId: '', authenticationMode: 'delegated-app' as const, accessRole: 'admin' as const, platformIdentity,
    };
    const order = await store.claimCommand({
      ...args, key: 'order:' + recordId, action: 'order', startedAt: new Date(now + 40).toISOString(),
      orderNotice: { recipientOpenIds: ['ou_buyer'], text: '原下单成功通知' },
    }, authorize);
    await store.beginPlatformCommandDispatch(order.entry.key, order.entry.fingerprint, order.entry.platformAttemptId!);
    const ownerId = 'synthetic-owner', mutationId = 'synthetic-receipt';
    const receipt: PurchaseWebReceiptCommand = {
      recordId, appId, ownerId, mutationId, taskId: 'purchase-receipt-' + webReceiptHash([appId, ownerId, mutationId]),
      fingerprint: '', platformIdentity, actor: { openId: '', name: '办理人', positions: [], buildings: [] },
      scope: { building: 'H楼' }, input: { signer: '签收人', signerOpenId: 'ou_signer', receiptTime: now + 11_000, note: '' },
      files: [{ name: 'receipt.png', mime: 'image/png', size: 2, sha256: 'c'.repeat(64), group: 'receiptPhotos',
        token: 'synthetic-receipt-token', uploadStartedAt: new Date(now + 11_000).toISOString() }],
      notificationWarnings: [], filesRemoved: false,
    };
    receipt.fingerprint = webReceiptFingerprint(receipt);
    await store.acceptWebReceipt(recordId, receipt, authorize);
    const task = (await store.takeNextNotification(now + 12_000, 60_000, ['web_receipt_command']))!;
    const accepted = await store.readAcceptedFulfillmentCommand({ notificationKey: task.key, claimToken: task.claimToken }, recordId, 'receive', '');
    const receive = await store.claimCommand({
      ...args, key: 'receive:' + recordId, action: 'receive', startedAt: new Date(now + 12_001).toISOString(),
    }, authorize, accepted.proof);
    await store.beginPlatformCommandDispatch(receive.entry.key, receive.entry.fingerprint, receive.entry.platformAttemptId!);
    await store.recordCommand({ ...receive.entry, completedAt: new Date(now + 12_002).toISOString() });
    await store.completeNotification(task.key, task.claimToken, {}, now + 12_003);
    await store.enqueueNotifications([{
      businessEventId: 'inventory-inbound-completed-resolution:' + recordId, recordId, kind: 'inventory_inbound_completed_resolution', recipientOpenId: 'system',
    }], now + 12_004);
    const resolution = (await store.takeNextNotification(now + 12_005, 60_000, ['inventory_inbound_completed_resolution']))!;
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(resolution.key, resolution.claimToken, [], now + 12_006);

    const cutoverAt = now + 360_000;
    const source = { ...record, status: '物品签收已入库', approvalActionId: eventId, approvalSource: '程序卡片',
      approvalWorkflowStatus: '已通过', warehouseConfirmed: true, purchaseCompleted: true, receiptConfirmed: true,
      purchaserOpenId: 'ou_buyer', signerOpenId: receipt.input.signerOpenId, receiptTime: receipt.input.receiptTime };
    const before = await readLedger();
    await expect(store.transitionLifecycleBatchToStageCards({
      ...candidate!, verifiedAt: cutoverAt, records: [{ ...source, receiptTime: 1 }],
    }, cutoverAt)).rejects.toThrow('未确认独立的签收入库终态');
    expect((await readLedger()).commands).toEqual(before.commands);
    const changed = await store.transitionLifecycleBatchToStageCards({
      ...candidate!, verifiedAt: cutoverAt, records: [source],
    }, cutoverAt);
    expect(changed.batch.stageCardTransition?.heldTerminalOrders).toMatchObject([{ recordId, claimSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
    expect((await readLedger()).commands).toEqual(before.commands);
    expect(await store.listPendingOrderNoticeCommands()).toEqual([]);
    expect(await store.completePendingOrderNoticeCommand(order.entry, cutoverAt)).toBe(false);
    expect(await store.releaseCommandClaim(order.entry.key, order.entry.fingerprint, order.entry.platformAttemptId, 'definite_rejection')).toBe(false);
    expect((await readLedger()).notifications.some((row: { kind: string }) => row.kind === 'purchase_order_completed')).toBe(false);
    await restartStore();
    expect(await store.findManagerApprovalBatch(batchId)).toMatchObject({ flowVersion: 'legacy', state: 'resolved' });
    expect(await store.findCommand(order.entry.key)).toEqual(before.commands.find((command: { key: string }) => command.key === order.entry.key));
    await restartStore();
    expect(await store.listLifecycleStageCardTransitionCandidates()).toEqual([]);
    expect(await store.listPendingOrderNoticeCommands()).toEqual([]);
  });
});
