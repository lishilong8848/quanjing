jest.mock('../../server/common/feishu-card-copy/transport', () => ({ isReadonlyCopyCallback: () => false, observeCardCallbackResult: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../server/common/hotfix-runtime-activation', () => ({ ...jest.requireActual('../../server/common/hotfix-runtime-activation'), currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }) }));
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { purchaseLifecycleFormSubmitName, type PurchaseLifecycleFormBinding } from '../../server/modules/purchase-inventory/purchase-lifecycle-form';
import { purchaseBatchReceiptFieldName } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { parsePurchaseLongConnectionCardAction } from '../../server/modules/purchase-inventory/purchase-workflow-callback';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';

describe('lifecycle form parsing and durable claims (offline)', () => {
  let directory: string, file: string, store: PurchaseWorkflowStore, previous: string | undefined;
  let allowed: boolean, roleAllowed: boolean, dutyAllowed: boolean, service: PurchaseManagerApprovalService, router: FeishuCardActionRouter;
  let previousApprover: string | undefined;
  const appId = 'cli_test_app', batchId = 'purchase-application-integration', recordId = 'rec_one';
  const now = Date.now(), manager = 'ou_manager', buyer = 'ou_buyer', requester = 'ou_requester';
  const managerId = { appId, batchId, recipientOpenId: manager };
  const managerMessage = 'om_manager';
  const cardContext = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: requester, requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: recordId, title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
  function callback(token: string, actorOpenId: string, messageId: string, values: Record<string, string>) {
    const result = parsePurchaseLongConnectionCardAction({ schema: '2.0', event_type: 'card.action.trigger', event_id: 'event_1', operator: { open_id: actorOpenId }, context: { open_message_id: messageId }, action: { tag: 'button', name: purchaseLifecycleFormSubmitName(token), form_value: values } }, { verificationToken: 'long_connection', encryptKey: '', legacyApproverOpenIds: [], managerApproverOpenId: manager, authorizeFromDeliverySnapshot: true });
    if (result.kind !== 'lifecycle_form_action') throw new Error('not a lifecycle form');
    return result;
  }

  async function deliver(identity: { appId: string; batchId: string; recipientOpenId: string }, messageId: string) {
    const outbox = (await store.getLifecycleOutbox(identity))!;
    const attempt = await store.beginLifecycleDelivery(identity, now + 1000, outbox.desiredRevision, outbox.desiredPage, () => {});
    await store.markLifecycleDeliveryDispatched(identity, attempt.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(identity, attempt.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: attempt.entry.replica.uuid, messageId, sentAtMs: now - 2000 } });
    return outbox.desiredRevision;
  }

  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    previousApprover = process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID; process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = manager;
    directory = await mkdtemp(join(tmpdir(), 'purchase-form-integration-')); file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    allowed = true; roleAllowed = true; dutyAllowed = true;
    const config = { canUseFeishuBusinessIdentity: () => allowed, currentDutyRoutePeople: () => dutyAllowed ? [{ openId: manager }, { openId: buyer }, { openId: requester }] : [], feishuPrincipal: () => ({ role: roleAllowed ? 'admin' : 'guest' }) };
    service = new PurchaseManagerApprovalService({} as never, store, undefined, undefined, undefined, config as never);
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    jest.spyOn(service, 'runAcceptedTasks').mockResolvedValue({ processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] });
    router = new FeishuCardActionRouter({} as never, {} as never, {} as never, store, service, {} as never, {} as never, undefined, config as never);
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: manager, requesterOpenId: requester, recordIds: [recordId], flowVersion: 'lifecycle_v1' }, now, { appId, recipients: [{ openId: manager, fullView: false }], authorityTargets: [{ recordId, target: { building: 'H楼' } }], authorize: () => {} });
    const request = await store.takeNextManagerApprovalNotification(new Date(now + 2000));
    await store.markManagerApprovalBatchSendStarted(request!.key, request!.claimToken, cardContext, new Date(now + 2000));
    await store.completeManagerApprovalBatchRequestAndRegisterCard(request!.key, request!.claimToken, { messageId: managerMessage }, new Date(now + 2000));
    await deliver(managerId, managerMessage);
  });
  afterEach(async () => { jest.restoreAllMocks(); await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; if (previousApprover === undefined) delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID; else process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = previousApprover; });

  it('rejects a stale card and a clock earlier than delivery before any authorization or mutation', async () => {
    const identity = { approvalBatchId: batchId, actorOpenId: manager, messageId: managerMessage, executionRecordId: recordId, lifecycle: { appId, cardRevision: 1 } };
    const before = await readFile(file, 'utf8');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 2001);
    await expect(store.openManagerApprovalBatchRejectEditor(identity, now, () => {})).rejects.toThrow('时间不可核对');
    clock.mockReturnValue(now - 2000 + 14 * 86400_000 + 1);
    await expect(store.openManagerApprovalBatchRejectEditor(identity, now, () => {})).rejects.toThrow('卡片已过期');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  async function approved() {
    await store.claimManagerApprovalBatchPendingApproval({ eventId: 'approve', approvalBatchId: batchId, choice: 'comprehensive', messageId: managerMessage, actorOpenId: manager, lifecycle: { appId, cardRevision: 1 } }, now + 2500, () => {});
    const action = await store.takeNextManagerApprovalBatchAction(now + 2500);
    await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, recordId, { purchaserOpenId: buyer, purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, now + 2600);
  }

  async function bindStage(kind: 'manager_batch_purchase_assigned' | 'manager_batch_receipt_requested', actorOpenId: string, messageId: string) {
    if (kind === 'manager_batch_receipt_requested') {
      const batch = (await store.findManagerApprovalBatch(batchId))!;
      await store.enqueueNotifications([{ kind, businessEventId: 'fixture-receipt', recordId, recipientOpenId: actorOpenId, cardContext: batch.cardContext }], new Date(now + 2700));
    }
    let task = await store.takeNextManagerApprovalNotification(new Date(now + 3000));
    while (task && task.kind !== kind) {
      await store.failNotification(task.key, task.claimToken, new Error('isolated fixture skips unrelated notification'), new Date(now + 3000));
      task = await store.takeNextManagerApprovalNotification(new Date(now + 3000));
    }
    expect(task).not.toBeNull();
    const enrolled = await store.enrollLifecycleRecipientFromNotification(task!.key, task!.claimToken, () => {});
    const identity = { appId, batchId, recipientOpenId: actorOpenId };
    const revision = await deliver(identity, messageId);
    await store.completeLifecycleStageNotification(task!.key, task!.claimToken, enrolled.stageTargetRevision, undefined, () => {}, now + 3100);
    return revision;
  }

  it('parses rejection against a durable server-bound identity and rejects changed authorization', async () => {
    const binding: PurchaseLifecycleFormBinding = { action: 'submit_item_reject', role: 'manager', approvalBatchId: batchId, executionRecordId: recordId, flowVersion: 'lifecycle_v1', cardRevision: 1 };
    const identity = { appId, actorOpenId: manager, messageId: managerMessage };
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now + 2);
    const event = callback(token, manager, managerMessage, { rejection_reason: '规格不符' });
    allowed = false;
    await expect(service.handleLifecycleForm(event)).rejects.toThrow('当前人员不可办理');
    allowed = true;
    dutyAllowed = false;
    await expect(service.handleLifecycleForm(event)).rejects.toThrow('采购岗位已变化');
    dutyAllowed = true; roleAllowed = false;
    await expect(service.handleLifecycleForm(event)).rejects.toThrow('审批权限已变化');
    roleAllowed = true;
    expect((await service.handleLifecycleForm(event)).claimed).toBe(true);
    expect((await service.handleLifecycleForm(event)).claimed).toBe(false);
    await expect(service.handleLifecycleForm({ ...event, eventId: 'different-event' })).rejects.toThrow();
  });

  it('dispatches an actual Feishu form event through the router to the manager service and durable claim', async () => {
    const binding: PurchaseLifecycleFormBinding = { action: 'submit_item_reject', role: 'manager', approvalBatchId: batchId, executionRecordId: recordId, flowVersion: 'lifecycle_v1', cardRevision: 1 };
    const identity = { appId, actorOpenId: manager, messageId: managerMessage };
    const token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now + 2);
    const payload = { schema: '2.0', event_type: 'card.action.trigger', event_id: 'router-event', operator: { open_id: manager }, context: { open_message_id: managerMessage }, action: { tag: 'button', name: purchaseLifecycleFormSubmitName(token), form_value: { rejection_reason: '规格不符' } } };
    const result = await router.handle(payload);
    expect(result.toast).toEqual({ type: 'info', content: '操作已受理，正在后台同步' });
    expect(JSON.parse(await readFile(file, 'utf8')).managerApprovalBatchActions).toHaveLength(1);
    expect(service.runAcceptedTasks).toHaveBeenCalledTimes(1);
  });

  it.each(['submit_order', 'submit_receipt'] as const)('parses %s and claims a single real ledger task', async action => {
    await approved();
    const isOrder = action === 'submit_order', actorOpenId = isOrder ? buyer : requester, role = isOrder ? 'purchaser' as const : 'requester' as const, messageId = isOrder ? 'om_buyer' : 'om_requester';
    const revision = await bindStage(isOrder ? 'manager_batch_purchase_assigned' : 'manager_batch_receipt_requested', actorOpenId, messageId);
    const binding: PurchaseLifecycleFormBinding = { action, role, approvalBatchId: batchId, executionRecordId: recordId, flowVersion: 'lifecycle_v1', cardRevision: revision };
    const identity = { appId, actorOpenId, messageId }, token = await store.issueLifecycleFormCredential(identity, binding, () => {}, now + 3200);
    const field = (base: 'signer_open_id' | 'receipt_time' | 'receipt_note') => purchaseBatchReceiptFieldName(base, recordId);
    const values = isOrder ? { actual_quantity: '1', actual_amount: '9.9', order_note: '' } : { [field('signer_open_id')]: requester, [field('receipt_time')]: '2026-11-04 12:00', [field('receipt_note')]: '' };
    const event = callback(token, actorOpenId, messageId, values);
    allowed = false;
    await expect(service.handleLifecycleForm(event)).rejects.toThrow('当前人员不可办理');
    allowed = true;
    if (!isOrder) {
      await expect(service.handleLifecycleForm(event)).rejects.toThrow('请先上传签收照片');
      await store.stagePurchaseBatchAttachments({ approvalBatchId: batchId, executionRecordId: recordId, actorOpenId, purpose: 'receipt', receiptPhotoTokens: ['file_photo'] }, now + 3202);
    }
    if (isOrder) {
      dutyAllowed = false;
      await expect(service.handleLifecycleForm(event)).rejects.toThrow('采购岗位已变化');
      dutyAllowed = true;
    }
    roleAllowed = false;
    await expect(service.handleLifecycleForm(event)).rejects.toThrow(isOrder ? '采购下单权限已变化' : '采购签收权限已变化');
    roleAllowed = true;
    expect((await service.handleLifecycleForm(event)).claimed).toBe(true);
    expect((await service.handleLifecycleForm(event)).claimed).toBe(false);
    await expect(service.handleLifecycleForm({ ...event, eventId: 'other-event' })).rejects.toThrow();
    expect(JSON.parse(await readFile(file, 'utf8')).lifecycleFormCredentials[0].consumedByEventId).toBe(event.eventId);
  });
});
