jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({
  isPurchaseManagerApprovalEnabled: () => true,
  readPurchaseManagerApprover: () => ({ openId: 'ou_manager_a', name: '合成甲' }),
  readPurchaseManagerApprovers: () => [{ openId: 'ou_manager_a', name: '合成甲' }, { openId: 'ou_manager_b', name: '合成乙' }],
}));

import { mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseManagerApprovalService, type PurchaseManagerApprovalTaskRunResult } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseWorkflowStore, type PurchaseWorkflowNotificationEntry, type PurchaseManagerApprovalActionEntry } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

type Worker = {
  processNotification(task: PurchaseWorkflowNotificationEntry, now: Date, result: PurchaseManagerApprovalTaskRunResult): Promise<boolean>;
  processAction(action: PurchaseManagerApprovalActionEntry, now: Date, result: PurchaseManagerApprovalTaskRunResult): Promise<boolean>;
};
const people = ['ou_manager_a', 'ou_manager_b'];
const originalAppId = process.env.FEISHU_APP_ID;
const record: PurchaseWorkflowRecord = {
  recordId: 'recServiceFixture', requestCode: 'SYNTHETIC-001', status: '未开始（待审批）', itemName: '合成物料', specification: '/', building: 'H楼', specialty: '电气', requesterOpenId: 'ou_requester', requesterName: '合成申请人', purchaserOpenId: '', purchaserName: '', purchaseMethod: '', rejectionReason: '', requestedQuantity: 1, unit: '件', unitPrice: 10,
  actualQuantity: null, actualAmount: null, approvalCompleted: false, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [],
};
const result = (): PurchaseManagerApprovalTaskRunResult => ({ processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] });
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}
function expectLocked(card: unknown) {
  expect(JSON.stringify(card)).not.toContain('"type":"callback"');
  const buttons = nodes(card).filter(node => node.tag === 'button');
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every(button => button.disabled === true)).toBe(true);
  expect(JSON.stringify(card)).toContain('已通过');
}

describe('multiple-manager real service card convergence', () => {
  let directory: string, temporaryRoot: string, file: string, store: PurchaseWorkflowStore, service: PurchaseManagerApprovalService, worker: Worker, clock: Date;
  let gateway: {
    getExecutionRecordAsApp: jest.Mock;
    sendInteractiveCard: jest.Mock;
    updateInteractiveCard: jest.Mock;
    updateExecutionRecordAsApp: jest.Mock;
  };
  const initializeService = () => {
    service = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
    worker = service as unknown as Worker;
  };
  beforeEach(async () => {
    process.env.FEISHU_APP_ID = 'cli_synthetic_multi_manager_service';
    temporaryRoot = await realpath(tmpdir()); directory = await mkdtemp(join(temporaryRoot, 'nt-multi-service-')); file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit(); clock = new Date(Date.now() + 1000);
    gateway = {
      getExecutionRecordAsApp: jest.fn(async () => ({ ...record })),
      sendInteractiveCard: jest.fn(async (recipient: string) => `om_${recipient}`),
      updateInteractiveCard: jest.fn(async () => undefined),
      updateExecutionRecordAsApp: jest.fn(async () => undefined),
    };
    initializeService();
  });
  afterEach(async () => {
    if (originalAppId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = originalAppId;
    await store.onModuleDestroy();
    if (resolve(dirname(directory)).toLowerCase() !== resolve(temporaryRoot).toLowerCase() || !basename(directory).startsWith('nt-multi-service-') || (await lstat(directory)).isSymbolicLink()) throw new Error('Synthetic test directory ownership changed');
    await rm(directory, { recursive: true, force: true });
  });
  async function nextNotification() {
    const task = await store.takeNextManagerApprovalNotification(clock);
    if (!task) throw new Error('Missing synthetic notification');
    return task;
  }
  async function deliverBoth() {
    await service.enqueueApprovalRequest(record.recordId);
    for (let i = 0; i < 2; i++) await notify(await nextNotification());
  }
  async function notify(task: PurchaseWorkflowNotificationEntry) {
    const summary = result();
    const succeeded = await worker.processNotification(task, clock, summary);
    if (!succeeded) throw new Error(summary.errors.join('; ') || 'Synthetic notification failed');
  }
  async function decide(actor: string, eventId: string) {
    await store.claimManagerApprovalAction({ recordId: record.recordId, messageId: `om_${actor}`, actorOpenId: actor, eventId, choice: 'comprehensive', rejectionReason: '' }, clock);
    const action = (await store.takeNextManagerApprovalAction(clock))!;
    await store.completeManagerApprovalActionAndEnqueueResolved(action.key, action.claimToken, clock);
  }
  async function failReject() {
    await store.openManagerApprovalRejectEditor({ recordId: record.recordId, actorOpenId: people[0], messageId: `om_${people[0]}` }, clock);
    await store.claimManagerApprovalAction({ recordId: record.recordId, actorOpenId: people[0], messageId: `om_${people[0]}`, eventId: 'reject-failed', choice: 'reject', rejectionReason: '仅甲填写的合成草稿' }, clock);
    gateway.updateExecutionRecordAsApp.mockRejectedValue(new Error('Synthetic rejected write; readback remains pending'));
    for (let attempt = 0; attempt < 5; attempt++) {
      const action = (await store.takeNextManagerApprovalAction(clock))!;
      expect(action).not.toBeNull();
      expect(await worker.processAction(action, clock, result())).toBe(false);
      clock = new Date(clock.getTime() + 10 * 60_000);
    }
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(5);
    expect((await store.listManagerApprovalActions())[0].status).toBe('failed');
  }
  async function drainNotifications() {
    for (let i = 0; i < 10; i++) {
      const task = await store.takeNextManagerApprovalNotification(clock);
      if (!task) return;
      expect(await worker.processNotification(task, clock, result())).toBe(true);
    }
    throw new Error('Synthetic notification queue did not settle');
  }

  it('persists and patches the late second card to the decision made while it was sending', async () => {
    await service.enqueueApprovalRequest(record.recordId);
    await notify(await nextNotification());
    gateway.sendInteractiveCard.mockImplementationOnce(async (recipient: string) => {
      await decide(people[0], 'decided-during-second-send');
      return `om_${recipient}`;
    });
    expect(await worker.processNotification(await nextNotification(), clock, result())).toBe(true);
    expect(await store.findManagerApprovalCard(`om_${people[1]}`, people[1])).toMatchObject({ state: 'resolved', actorOpenId: people[0] });
    expect((await store.listNotifications({ kind: 'manager_approval_resolved' })).map(row => row.recipientOpenId).sort()).toEqual([...people].sort());
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit(); initializeService();
    await drainNotifications();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.updateInteractiveCard.mock.calls.map(call => call[0]).sort()).toEqual(people.map(person => `om_${person}`).sort());
    for (const [, card] of gateway.updateInteractiveCard.mock.calls) expectLocked(card);
    expect(await store.listManagerApprovalActions()).toHaveLength(1);
  });

  it('reopens only the failed rejecting actor editor and keeps the other copy free of its draft', async () => {
    await deliverBoth(); await failReject(); await drainNotifications();
    const updates = new Map(gateway.updateInteractiveCard.mock.calls.map(([messageId, card]) => [messageId, card]));
    expect(JSON.stringify(updates.get(`om_${people[0]}`))).toContain('仅甲填写的合成草稿');
    expect(nodes(updates.get(`om_${people[0]}`)).some(node => node.tag === 'input')).toBe(true);
    expect(JSON.stringify(updates.get(`om_${people[1]}`))).not.toContain('仅甲填写的合成草稿');
    expect(nodes(updates.get(`om_${people[1]}`)).some(node => node.tag === 'input')).toBe(false);
    expect(await store.findManagerApprovalCard(`om_${people[1]}`, people[1])).toMatchObject({ state: 'initial', rejectionReasonDraft: '' });
  });

  it('converges the late second batch card with a persisted refresh for both managers', async () => {
    const approvalBatchId = 'synthetic-batch-service';
    await service.enqueueApprovalBatch({ approvalBatchId, requesterOpenId: record.requesterOpenId, recordIds: [record.recordId] });
    await notify(await nextNotification());
    gateway.sendInteractiveCard.mockImplementationOnce(async (recipient: string) => {
      await store.claimManagerApprovalBatchPendingApproval({ approvalBatchId, actorOpenId: people[0], messageId: `om_${people[0]}`, eventId: 'batch-decided-during-second-send', choice: 'comprehensive' }, clock);
      const action = (await store.takeNextManagerApprovalBatchAction(clock))!;
      await store.completeManagerApprovalBatchActionRecord(action.key, action.claimToken, record.recordId, { purchaserOpenId: 'ou_purchaser', purchaserName: '合成采购人' }, clock);
      return `om_${recipient}`;
    });
    await notify(await nextNotification());
    expect(await store.findManagerApprovalBatchCard(`om_${people[1]}`, people[1])).toMatchObject({ state: 'resolved', actorOpenId: people[0] });
    expect((await store.listNotifications({ kind: 'manager_batch_approval_refresh' })).map(row => row.recipientOpenId).sort()).toEqual([...people].sort());
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit(); initializeService();
    let patched = 0;
    for (let i = 0; i < 8 && patched < 2; i++) {
      const task = await nextNotification();
      if (task.kind === 'manager_batch_approval_refresh') { await notify(task); patched++; }
      else await store.rescheduleNotification(task.key, task.claimToken, 'Unrelated fulfillment worker deferred by fixture', new Date(clock.getTime() + 3600000), clock);
    }
    expect(patched).toBe(2);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    for (const [, card] of gateway.updateInteractiveCard.mock.calls) {
      expect(JSON.stringify(card)).not.toContain('"type":"callback"');
      expect(JSON.stringify(card)).toContain('综合采购');
      expect(nodes(card).filter(node => node.tag === 'button').every(button => button.disabled === true)).toBe(true);
    }
    expect(await store.listManagerApprovalBatchActions()).toHaveLength(1);
  });

  it('renders the current terminal state when an old reopen task runs after a newer decision', async () => {
    await deliverBoth(); await failReject();
    await decide(people[1], 'new-approved-decision');
    await drainNotifications();
    expect(gateway.updateInteractiveCard).toHaveBeenCalledTimes(4);
    for (const [, card] of gateway.updateInteractiveCard.mock.calls) expectLocked(card);
    expect(await store.findManagerApprovalCard(`om_${people[0]}`, people[0])).toMatchObject({ state: 'resolved', actorOpenId: people[1] });
  });

  it('retries only the failed recipient PATCH after restart without replaying the decision or other copy', async () => {
    await deliverBoth(); await decide(people[0], 'approved-once');
    let fail = true;
    gateway.updateInteractiveCard.mockImplementation(async (messageId: string) => { if (messageId === `om_${people[0]}` && fail) { fail = false; throw new Error('Synthetic transient PATCH failure'); } });
    expect(await worker.processNotification(await nextNotification(), clock, result())).toBe(false);
    expect(await worker.processNotification(await nextNotification(), clock, result())).toBe(true);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file); await store.onModuleInit(); initializeService();
    clock = new Date(clock.getTime() + 10 * 60_000);
    await drainNotifications();
    const messages = gateway.updateInteractiveCard.mock.calls.map(call => call[0]);
    expect(messages.filter(value => value === `om_${people[0]}`)).toHaveLength(2);
    expect(messages.filter(value => value === `om_${people[1]}`)).toHaveLength(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(await store.listManagerApprovalActions()).toHaveLength(1);
    expect((await store.listNotifications({ kind: 'manager_approval_resolved' })).every(row => row.status === 'completed')).toBe(true);
  });
});
