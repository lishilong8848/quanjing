import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore, managerBatchDeliveries } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerBatchApprovalCardContext, type PurchaseManagerBatchApprovalCardInput } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';

const now = new Date('2026-10-26T00:00:00Z');
const people = [{ openId: 'ou_manager_a', name: '经理甲' }, { openId: 'ou_manager_b', name: '经理乙' }];
const context: PurchaseManagerBatchApprovalCardInput = {
  version: 3, approvalBatchId: 'multi-batch-1', requesterOpenId: 'ou_requester', requesterName: '申请人',
  building: 'H楼', requestCode: 'CG-TEST-001', expectedDeliveryAt: '2026-11-01', createdAt: '2026-10-26',
  items: ['rec-1', 'rec-2'].map(executionRecordId => ({ executionRecordId, title: executionRecordId, specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' })),
};
const serialized = serializePurchaseManagerBatchApprovalCardContext(context);

describe('shared manager batch and recipient deliveries', () => {
  let directory: string; let path: string; let store: PurchaseWorkflowStore;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'multi-manager-')); path = join(directory, 'ledger.json'); store = new PurchaseWorkflowStore(path); await store.onModuleInit(); });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const register = async (multi = true) => store.registerManagerApprovalBatch({ approvalBatchId: context.approvalBatchId, recipientOpenId: people[0]!.openId, requesterOpenId: context.requesterOpenId, recordIds: ['rec-1', 'rec-2'], ...(multi ? { managers: people } : {}) }, now);
  const delivery = async (messageId: string) => {
    const task = await store.takeNextManagerApprovalNotification(now);
    expect(task?.kind).toBe('manager_batch_approval_requested');
    await store.markManagerApprovalBatchSendStarted(task!.key, task!.claimToken, serialized, now);
    return store.completeManagerApprovalBatchRequestAndRegisterCard(task!.key, task!.claimToken, { messageId }, now);
  };
  const identity = (index: number) => ({ approvalBatchId: context.approvalBatchId, actorOpenId: people[index]!.openId, messageId: `om_${index}` });
  const approve = (index: number, eventId: string) => store.claimManagerApprovalBatchPendingApproval({ ...identity(index), eventId, choice: 'comprehensive' }, now);
  const finish = async () => {
    const action = await store.takeNextManagerApprovalBatchAction(now);
    for (const id of action!.recordIds) await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, id, { purchaserOpenId: 'ou_purchaser', purchaserName: '采购人' }, now);
  };

  it('delivers two independent messages and allows exactly one concurrent legal decision', async () => {
    await register(); await delivery('om_0'); await delivery('om_1');
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => approve(i % 2, `event-${i}`)));
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    await finish();
    for (const [i, person] of people.entries()) expect(await store.findManagerApprovalBatchCard(`om_${i}`, person.openId)).toMatchObject({ state: 'resolved', items: [expect.objectContaining({ status: 'approved' }), expect.objectContaining({ status: 'approved' })] });
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).map(task => task.recipientOpenId).sort()).toEqual(people.map(person => person.openId).sort());
  });

  it('keeps each reject editor independent and removes only the draft that was decided', async () => {
    await register(); await delivery('om_0'); await delivery('om_1');
    await store.openManagerApprovalBatchRejectEditor({ ...identity(0), executionRecordId: 'rec-1' }, now);
    await store.openManagerApprovalBatchRejectEditor({ ...identity(1), executionRecordId: 'rec-2' }, now);
    expect(await store.findManagerApprovalBatchCard('om_0', people[0]!.openId)).toMatchObject({ selectedRejectRecordId: 'rec-1' });
    expect(await store.findManagerApprovalBatchCard('om_1', people[1]!.openId)).toMatchObject({ selectedRejectRecordId: 'rec-2' });
    await store.claimManagerApprovalBatchItemReject({ ...identity(0), executionRecordId: 'rec-1', eventId: 'reject-1', rejectionReason: '规格错误' }, now);
    await finish();
    expect(await store.findManagerApprovalBatchCard('om_1', people[1]!.openId)).toMatchObject({ state: 'reject_editing', selectedRejectRecordId: 'rec-2' });
    expect(await store.findManagerApprovalBatchCard('om_0', people[0]!.openId)).toMatchObject({ state: 'active', selectedRejectRecordId: '' });
  });

  it('registers a late second delivery against the already resolved shared state', async () => {
    await register(); await delivery('om_0');
    const pending = await store.takeNextManagerApprovalNotification(now);
    await store.markManagerApprovalBatchSendStarted(pending!.key, pending!.claimToken, serialized, now);
    await approve(0, 'event-before-second-delivery'); await finish();
    const completed = await store.completeManagerApprovalBatchRequestAndRegisterCard(pending!.key, pending!.claimToken, { messageId: 'om_1' }, now);
    expect(completed.batch.state).toBe('resolved');
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).some(task => task.recipientOpenId === people[1]!.openId)).toBe(true);
    expect((await approve(1, 'event-too-late')).claimed).toBe(false);
  });

  it('rejects using another manager copy message as the second delivery', async () => {
    await register(); await delivery('om_0');
    const pending = await store.takeNextManagerApprovalNotification(now);
    await store.markManagerApprovalBatchSendStarted(pending!.key, pending!.claimToken, serialized, now);
    await expect(store.completeManagerApprovalBatchRequestAndRegisterCard(pending!.key, pending!.claimToken, { messageId: 'om_0' }, now)).rejects.toThrow('消息已绑定');
    await store.rescheduleNotification(pending!.key, pending!.claimToken, new Error('timeout'), now, now);
    await store.takeNextManagerApprovalNotification(new Date(now.getTime() + 61 * 60_000));
    await expect(store.bindUnknownManagerApprovalBatchDeliveryFromCallback({ ...identity(1), messageId: 'om_0' }, now)).rejects.toThrow('消息已绑定');
  });

  it('keeps legacy single-delivery authorization after snapshot migration', async () => {
    await register(false); await delivery('om_0'); await store.onModuleDestroy();
    const ledger = JSON.parse(await readFile(path, 'utf8')); delete ledger.managerApprovalBatches[0].managerDeliveries;
    await writeFile(path, JSON.stringify(ledger)); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    expect(managerBatchDeliveries((await store.findManagerApprovalBatch(context.approvalBatchId))!)).toHaveLength(1);
    await register(true); // current global config must not widen already delivered authority
    expect(await store.findManagerApprovalBatchCard('om_0', people[1]!.openId)).toBeNull();
    await expect(store.bindUnknownManagerApprovalBatchDeliveryFromCallback(identity(1), now)).rejects.toThrow();
  });

  it('retains a failed copy refresh for retry across restart without another business action', async () => {
    await register(); await delivery('om_0'); await delivery('om_1'); await approve(0, 'event-retry'); await finish();
    const task = await store.takeNextManagerApprovalNotification(now);
    expect(task?.kind).toBe('manager_batch_approval_refresh');
    await store.rescheduleNotification(task!.key, task!.claimToken, new Error('temporary PATCH error'), new Date(now.getTime() + 1000), now);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    expect((await store.listManagerApprovalBatchActions()).filter(action => action.status === 'completed')).toHaveLength(1);
    expect(await store.getNotification(task!.key)).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('persists a terminal PATCH when a late unknown delivery is bound by callback', async () => {
    await register(); await delivery('om_0');
    const late = await store.takeNextManagerApprovalNotification(now);
    await store.markManagerApprovalBatchSendStarted(late!.key, late!.claimToken, serialized, now);
    await store.rescheduleNotification(late!.key, late!.claimToken, new Error('timeout'), now, now);
    await store.takeNextManagerApprovalNotification(new Date(now.getTime() + 61 * 60_000));
    await approve(0, 'event-before-late-callback'); await finish();
    const bound = await store.bindUnknownManagerApprovalBatchDeliveryFromCallback(identity(1), now);
    expect(bound.batch.state).toBe('resolved');
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).some(task => task.recipientOpenId === people[1]!.openId && task.status === 'pending')).toBe(true);
  });

  it('rejects the entire multi-recipient registration when only one queue slot is left', async () => {
    await store.enqueueNotifications(Array.from({ length: 499 }, (_, index) => ({ businessEventId: `capacity-${index}`, recordId: `rec-cap-${index}`, recipientOpenId: 'ou_other', kind: 'purchase_assigned' as const })), now);
    await expect(register()).rejects.toThrow('队列已满');
    expect(await store.findManagerApprovalBatch(context.approvalBatchId)).toBeNull();
    expect(await store.listNotifications()).toHaveLength(499);
  });

  it('preserves a resolved batch while another delivery remains pending beyond history trimming', async () => {
    await register(); await delivery('om_0');
    for (const [i, item] of context.items.entries()) {
      await store.openManagerApprovalBatchRejectEditor({ ...identity(0), executionRecordId: item.executionRecordId }, now);
      await store.claimManagerApprovalBatchItemReject({ ...identity(0), executionRecordId: item.executionRecordId, eventId: `reject-all-${i}`, rejectionReason: '取消采购' }, now);
      await finish();
    }
    await store.onModuleDestroy();
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    const original = ledger.managerApprovalBatches[0];
    for (let i = 0; i < 501; i++) {
      const copy = structuredClone(original); copy.approvalBatchId = `history-batch-${i}`;
      const ctx = JSON.parse(copy.cardContext); ctx.approvalBatchId = copy.approvalBatchId; copy.cardContext = JSON.stringify(ctx);
      copy.managerDeliveries = [{ ...copy.managerDeliveries[0], messageId: `om_history_${i}`, sourceNotificationKey: `history-${i}` }];
      copy.sourceNotificationKey = `history-${i}`; copy.messageId = `om_history_${i}`;
      ledger.managerApprovalBatches.push(copy);
    }
    await writeFile(path, JSON.stringify(ledger)); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    expect(await store.findManagerApprovalBatch(context.approvalBatchId)).toMatchObject({ state: 'resolved' });
    expect((await store.listManagerApprovalBatchIds())).toHaveLength(501);
  });

  it.each(['resolved', 'manual_reconciliation'] as const)('shares single-card %s decisions with a card registered after the first manager acted', async outcome => {
    const cardContext = serializePurchaseManagerApprovalCardContext({ executionRecordId: 'rec-single', requester: '申请人', building: 'H楼', title: '物料', quantity: 1 });
    await store.enqueueNotifications(people.map(person => ({ businessEventId: 'manager_approval_requested:rec-single', recordId: 'rec-single', recipientOpenId: person.openId, kind: 'manager_approval_requested' as const })), now);
    const first = (await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalSendStarted(first.key, first.claimToken, cardContext, now);
    await store.completeManagerApprovalRequestAndRegisterCard(first.key, first.claimToken, { messageId: 'om_single_0' }, now);
    const second = (await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalSendStarted(second.key, second.claimToken, cardContext, now);
    await store.claimManagerApprovalAction({ recordId: 'rec-single', eventId: 'single-event', actorOpenId: people[0]!.openId, messageId: 'om_single_0', choice: 'comprehensive', rejectionReason: '' }, now);
    const action = (await store.takeNextManagerApprovalAction(now))!;
    if (outcome === 'resolved') await store.completeManagerApprovalActionAndEnqueueResolved(action.key, action.claimToken, now);
    else await store.markManagerApprovalManualReconciliation(action.key, action.claimToken, new Error('unknown external state'), now);
    await store.completeManagerApprovalRequestAndRegisterCard(second.key, second.claimToken, { messageId: 'om_single_1' }, now);
    expect(await store.findManagerApprovalCard('om_single_1', people[1]!.openId)).toMatchObject({ state: outcome, actorOpenId: people[0]!.openId });
    expect((await store.listNotifications({ kind: outcome === 'resolved' ? 'manager_approval_resolved' : 'manager_approval_attention_required' })).map(task => task.recipientOpenId).sort()).toEqual(people.map(person => person.openId).sort());
    await store.onModuleDestroy();
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    for (const card of persisted.managerApprovalCards) { card.resolvedAt = '2025-01-01T00:00:00Z'; card.updatedAt = card.resolvedAt; }
    await writeFile(path, JSON.stringify(persisted)); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    expect(await store.findManagerApprovalCard('om_single_1', people[1]!.openId)).toMatchObject({ state: outcome });
  });

  it('defers card order observers until receipt intents commit, including restart and duplicate completion recovery', async () => {
    const command = { key: 'order:rec-1', recordId: 'rec-1', action: 'order' as const, actorOpenId: 'ou_purchaser', accessRole: 'admin' as const,
      authenticationMode: 'delegated-app' as const, fingerprint: 'same-command', expectedResultFingerprint: 'same-result', startedAt: now.toISOString(),
      orderNotice: { recipientOpenIds: ['ou_requester', 'ou_purchaser', ...people.map(person => person.openId)], text: '已下单，等待签收', deferUntilFulfillment: true } };
    await store.claimCommand(command);
    await store.recordCommand({ ...command, completedAt: now.toISOString(), notificationWarnings: [] });
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await store.recordCommand({ ...command, completedAt: now.toISOString(), notificationWarnings: [] });
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
    await store.enqueueNotification({ businessEventId: 'order-parent', recordId: 'rec-1', recipientOpenId: 'ou_purchaser', kind: 'manager_batch_order_command', cardContext: JSON.stringify({ version: 4, workflowType: 'purchase_batch_fulfillment', action: 'order', approvalBatchId: context.approvalBatchId, executionRecordId: 'rec-1', actorOpenId: 'ou_purchaser', actualQuantity: 1, actualAmount: 1, note: '', paymentAttachmentTokens: [] }) }, now);
    const parent = (await store.takeNextManagerApprovalNotification(now))!;
    await store.completePurchaseBatchFulfillmentCommandAndEnqueue(parent.key, parent.claimToken, [
      { businessEventId: 'receipt-intent', recordId: 'rec-1', recipientOpenId: 'ou_requester', kind: 'manager_batch_receipt_requested', cardContext: serialized },
      { businessEventId: 'purchase-refresh', recordId: 'rec-1', recipientOpenId: 'ou_purchaser', kind: 'manager_batch_purchase_refresh', cardContext: serialized },
    ], now);
    expect((await store.listNotifications({ kind: 'purchase_order_completed' })).map(task => task.recipientOpenId).sort()).toEqual(people.map(person => person.openId).sort());
    await store.recordCommand({ ...command, completedAt: now.toISOString(), notificationWarnings: [] });
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(2);
  });
});
