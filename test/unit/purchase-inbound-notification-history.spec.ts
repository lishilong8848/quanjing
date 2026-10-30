jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: (name: string) => name === 'PURCHASE_WORKFLOW_PROGRAM_ENABLED' ? 'false' : '',
  parseFeishuBitableLink: () => ({ appToken: '', wikiToken: '', tableId: '', viewId: '' }),
}));
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore, inboundCompletionSnapshot, type PurchaseWorkflowNotificationEntry, type PurchaseWorkflowNotificationInput } from '../../server/modules/purchase-inventory/purchase-workflow.store';

jest.setTimeout(30_000);
const base = Date.parse('2026-10-01T00:00:00.000Z'), at = (milliseconds: number) => new Date(base + milliseconds);
const id = 'recSyntheticHistory', old = 'ou_synthetic_original', other = 'ou_synthetic_other', added = 'ou_synthetic_late';
const notification = (recordId = id, recipientOpenId = old): PurchaseWorkflowNotificationInput => ({
  businessEventId: `inventory-inbound-completed:${recordId}`, recordId, recipientOpenId, kind: 'inventory_inbound_completed',
});
const resolution = (recordId = id): PurchaseWorkflowNotificationInput => ({
  businessEventId: `inventory-inbound-completed-resolution:${recordId}`, recordId, recipientOpenId: 'system', kind: 'inventory_inbound_completed_resolution',
});
function record() { return { recordId: id, requestCode: 'SYNTHETIC-001', status: '物品签收已入库', building: 'H楼', requesterOpenId: old,
  requestedQuantity: 1, actualQuantity: 1, itemName: '合成物品', sku: 'SYN-1', specification: '合成规格', unit: '件', location: '合成库房' }; }

describe('inbound notification event snapshot and historical replay protection (no app/network)', () => {
  let directory: string, ledgerPath: string, store: PurchaseWorkflowStore, gateway: any, service: PurchaseWorkflowService;
  const stores: PurchaseWorkflowStore[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-inbound-snapshot-')); ledgerPath = join(directory, 'ledger.json');
    writeFileSync(join(directory, '.owner'), 'synthetic-owned');
    store = new PurchaseWorkflowStore(ledgerPath); stores.push(store);
    gateway = { getExecutionRecordAsApp: jest.fn(async () => record()), listExecutionRecordsAsApp: jest.fn(async () => [record()]),
      resolveInboundResponsibleUsersAsApp: jest.fn(async () => [{ openId: old, name: '合成责任人' }]),
      resolveInboundManagerNotificationUsersAsApp: jest.fn(async () => [{ openId: other, name: '合成知会人' }]),
      getCachedInboundCompletionRecipients: jest.fn(() => { throw new Error('early cached dispatch must not be used'); }),
      sendInteractiveCard: jest.fn(async () => 'om_synthetic_' + randomUUID()),
    };
    service = new PurchaseWorkflowService(gateway, store);
  });
  afterEach(async () => {
    service.onModuleDestroy(); for (const current of stores.splice(0)) await current.onModuleDestroy();
    if (resolve(dirname(directory)).toLowerCase() !== resolve(realpathSync(tmpdir())).toLowerCase() || readFileSync(join(directory, '.owner'), 'utf8') !== 'synthetic-owned') throw new Error('fixture owner mismatch');
    rmSync(directory, { recursive: true });
  });
  async function seal(recipients = [old, other], accepted = 0, sealed = 2) {
    await store.enqueueNotifications([resolution()], at(accepted));
    const claimed = await store.takeNextNotification(at(accepted + 1), undefined, ['inventory_inbound_completed_resolution']);
    expect(claimed).not.toBeNull();
    return store.completeInboundCompletedResolutionAndEnqueueNotifications(claimed!.key, claimed!.claimToken, recipients.map(value => notification(id, value)), at(sealed));
  }
  function disk() { return JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  async function restart(state = disk()) { await store.onModuleDestroy(); writeFileSync(ledgerPath, JSON.stringify(state)); store = new PurchaseWorkflowStore(ledgerPath); stores.push(store); service = new PurchaseWorkflowService(gateway, store); }

  it('normal first inbound resolves a complete cohort once and sends both recipients', async () => {
    const movement = { recordId: 'syntheticMovement', clientMutationId: 'syntheticInbound', type: 'inbound', sku: 'SYN-1', specification: '规格', location: '库房', building: 'H楼' } as any;
    expect(await service.enqueueCompletionNotifications(id, movement)).toBe(1);
    expect(gateway.getCachedInboundCompletionRecipients).not.toHaveBeenCalled();
    expect(await service.runPendingTasks(10)).toMatchObject({ failed: 0, processed: 3, recoveredCompletionNotifications: 0 });
    expect(gateway.sendInteractiveCard.mock.calls.map((call: any[]) => call[0]).sort()).toEqual([old, other].sort());
    const before = await store.listNotifications();
    expect(inboundCompletionSnapshot(before, id, 'inventory_inbound_completed').notifications).toHaveLength(2);
    gateway.resolveInboundManagerNotificationUsersAsApp.mockResolvedValue([{ openId: added, name: '后来变更的人员' }]);
    expect(await service.enqueueCompletionNotifications(id, movement)).toBe(0);
    await service.runPendingTasks(10, new Date(Date.now() + 70_000));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.listExecutionRecordsAsApp).not.toHaveBeenCalled();
    expect((await store.listNotifications()).map(row => row.key)).toEqual(before.map(row => row.key));
  });

  it('a partially failed cohort retries only its original recipient and exact UUID after role changes', async () => {
    await service.enqueueCompletionNotifications(id);
    let secondAttempts = 0;
    gateway.sendInteractiveCard.mockImplementation(async (recipient: string) => {
      if (recipient === other && ++secondAttempts === 1) throw new Error('synthetic transport uncertainty');
      return `om_synthetic_${recipient}`;
    });
    const now = new Date(); await service.runPendingTasks(3, now);
    const pending = (await store.listNotifications({ recipientOpenId: other }))[0];
    expect(pending).toMatchObject({ status: 'pending', sendOutcome: 'unknown' });
    gateway.resolveInboundManagerNotificationUsersAsApp.mockResolvedValue([{ openId: added }]);
    await service.runPendingTasks(3, new Date(now.getTime() + 2_000));
    expect(gateway.sendInteractiveCard.mock.calls.filter((call: any[]) => call[0] === old)).toHaveLength(1);
    const retried = gateway.sendInteractiveCard.mock.calls.filter((call: any[]) => call[0] === other);
    expect(retried).toHaveLength(2); expect(retried[0][2]).toBe(retried[1][2]);
    expect(gateway.sendInteractiveCard.mock.calls.some((call: any[]) => call[0] === added)).toBe(false);
    expect(gateway.resolveInboundManagerNotificationUsersAsApp).toHaveBeenCalledTimes(1);
  });

  it('a failed resolution remains a durable outbox and freezes recipients only on first successful resolution', async () => {
    await service.enqueueCompletionNotifications(id); const now = new Date();
    gateway.resolveInboundResponsibleUsersAsApp.mockRejectedValueOnce(new Error('synthetic directory unavailable'));
    expect(await service.runPendingTasks(1, now)).toMatchObject({ failed: 1, processed: 0 });
    expect(await store.listNotifications({ kind: 'inventory_inbound_completed' })).toHaveLength(0);
    expect((await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' }))[0].status).toBe('pending');
    await service.runPendingTasks(5, new Date(now.getTime() + 2_000));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect((await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' }))[0].status).toBe('completed');
  });

  it('a required purchase-recipient source failure retries the resolver without freezing a partial cohort', async () => {
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    gateway.getExecutionRecordAsApp.mockResolvedValue({ ...record(), requesterOpenId: 'ou_synthetic_requester' });
    gateway.resolvePurchaseAdminAsApp = jest.fn().mockRejectedValueOnce(new Error('synthetic directory unavailable')).mockResolvedValue({ openId: 'ou_synthetic_admin' });
    gateway.resolveConfiguredApproversAsApp = jest.fn().mockResolvedValue([{ openId: 'ou_synthetic_approver' }]);
    await store.enqueueNotifications([resolution()], at(0));
    const first = await store.takeNextNotification(at(1));
    expect(await (service as any).processNotification(first, at(2), { failed: 0, errors: [] })).toBe(false);
    expect(await store.listNotifications({ kind: 'inventory_inbound_completed' })).toHaveLength(0);
    expect((await store.getNotification(first!.key))?.status).toBe('pending');
    const retry = await store.takeNextNotification(at(2_002));
    expect(await (service as any).processNotification(retry, at(2_003), { failed: 0, errors: [] })).toBe(true);
    const snapshot = inboundCompletionSnapshot(await store.listNotifications(), id, 'inventory_inbound_completed');
    expect(snapshot.notifications.map(row => row.recipientOpenId).sort()).toEqual([old, other, 'ou_synthetic_requester', 'ou_synthetic_admin', 'ou_synthetic_approver'].sort());
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('holds an already queued historical extra recipient for review without changing the old event', async () => {
    await seal([old]); const before = (await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' }))[0];
    await store.enqueueNotifications([notification(id, added)], at(100_000));
    const claimed = await store.takeNextNotification(at(100_001)); expect(claimed?.recipientOpenId).toBe(old);
    expect((await store.listNotifications({ recipientOpenId: added }))[0]).toMatchObject({ status: 'manual_reconciliation', sendOutcome: 'manual_reconciliation', lastError: expect.stringContaining('历史入库通知') });
    expect((await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' }))[0]).toEqual(before);
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('uses the exact atomic createdAt boundary and waits for an unfinished resolution', async () => {
    await store.enqueueNotifications([resolution()], at(0)); await store.enqueueNotifications([notification(id, other)], at(1));
    expect(await store.takeNextNotification(at(2), undefined, ['inventory_inbound_completed'])).toBeNull();
    const claimed = await store.takeNextNotification(at(3), undefined, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(claimed!.key, claimed!.claimToken, [notification()], at(4));
    await store.enqueueNotifications([notification(id, added)], at(5));
    const all = await store.listNotifications(); const frozen = inboundCompletionSnapshot(all, id, 'inventory_inbound_completed');
    expect(frozen.notifications.map(row => row.recipientOpenId).sort()).toEqual([old, other].sort());
    expect(frozen.notifications.find(row => row.recipientOpenId === old)?.createdAt).toBe(at(4).toISOString());
    await store.takeNextNotification(at(6));
    expect((await store.listNotifications({ recipientOpenId: added }))[0].status).toBe('manual_reconciliation');
  });

  it('unknown legacy pending tasks do not send, while an evidenced original partial recipient remains eligible', async () => {
    await store.enqueueNotifications([notification(), notification(id, other)], at(0));
    let state = disk(); const first = state.notifications[0]; Object.assign(first, { status: 'completed', messageId: 'om_synthetic_old', sendOutcome: 'delivered', firstSendAttemptAt: at(1).toISOString(), completedAt: at(2).toISOString() });
    await restart(state); await store.enqueueNotifications([notification(id, added), notification('recUnknown')], at(100));
    const claimed = await store.takeNextNotification(at(101)); expect(claimed?.recipientOpenId).toBe(other);
    const queued = await store.listNotifications();
    expect(queued.find(row => row.recipientOpenId === added)?.status).toBe('manual_reconciliation');
    expect(queued.find(row => row.recordId === 'recUnknown')?.status).toBe('manual_reconciliation');
  });

  it('checks evidence again before I/O for a legacy processing claim and leaves it in review', async () => {
    await store.enqueueNotifications([notification()], at(0)); const state = disk();
    Object.assign(state.notifications[0], { status: 'processing', attempts: 1, claimToken: randomUUID(), leaseUntil: at(1_000).toISOString() });
    await restart(state); const task = (await store.listNotifications())[0];
    const result: any = { failed: 0, errors: [] };
    expect(await (service as any).processNotification(task, at(10), result)).toBe(false);
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.getNotification(task.key))?.status).toBe('manual_reconciliation');
    expect(result.failed).toBe(1);
  });

  it('never resets an already successful legacy reused-message card to pending', async () => {
    await seal([old]); const state = disk(), child = state.notifications.find((row: any) => row.kind === 'inventory_inbound_completed');
    Object.assign(child, { status: 'completed', messageId: 'om_synthetic_same', sendOutcome: 'delivered', firstSendAttemptAt: '', completedAt: at(5).toISOString() });
    state.notifications.push({ ...child, key: 'warehouse-proof', businessEventId: `warehouse-inbound:${id}`, kind: 'warehouse_inbound' });
    await restart(state); expect(await store.takeNextNotification(at(6))).toBeNull();
    expect(await store.getNotification(child.key)).toMatchObject({ status: 'completed', messageId: 'om_synthetic_same', deliveryUuid: child.deliveryUuid });
  });

  it('retains delivery and resolution tombstones beyond both old caps across restart without overwriting an archive', async () => {
    await seal([old]); const state = disk();
    const marker = state.notifications.find((row: any) => row.kind.endsWith('_resolution'));
    const receipt = state.notifications.find((row: any) => row.kind === 'inventory_inbound_completed');
    Object.assign(receipt, { status: 'completed', messageId: 'om_synthetic_first', sendOutcome: 'delivered', completedAt: at(5).toISOString(), firstSendAttemptAt: at(4).toISOString() });
    for (let i = 0; i < 600; i++) state.notifications.push({ ...receipt, key: `success-${i}`, recordId: `recSuccess${i}`, businessEventId: `inventory-inbound-completed:recSuccess${i}` });
    for (let i = 0; i < 5_001; i++) state.notifications.push({ ...marker, key: `resolution-${i}`, recordId: `recResolution${i}`, businessEventId: `inventory-inbound-completed-resolution:recResolution${i}` });
    const archive = join(directory, 'original-ledger.archive.json'), archiveBytes = JSON.stringify(state); writeFileSync(archive, archiveBytes);
    await restart(state); expect(await store.listNotifications({ kind: 'inventory_inbound_completed' })).toHaveLength(601);
    expect(await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' })).toHaveLength(5_002);
    expect((await store.enqueueNotifications([notification()], at(200)))[0].enqueued).toBe(false);
    expect(await store.takeNextNotification(at(201))).toBeNull();
    expect(readFileSync(archive, 'utf8')).toBe(archiveBytes);
    expect(await store.getNotification(receipt.key)).toMatchObject({ status: 'completed', messageId: receipt.messageId, deliveryUuid: receipt.deliveryUuid, createdAt: receipt.createdAt });
  });

  it('a reintroduced resolution cannot expand an already successful legacy recipient cohort', async () => {
    await store.enqueueNotifications([notification()], at(0)); const state = disk();
    Object.assign(state.notifications[0], { status: 'completed', messageId: 'om_synthetic_first', sendOutcome: 'delivered', firstSendAttemptAt: at(1).toISOString(), completedAt: at(2).toISOString() });
    await restart(state); await store.enqueueNotifications([resolution()], at(100));
    const task = await store.takeNextNotification(at(101));
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(task!.key, task!.claimToken, [notification(), notification(id, added)], at(102));
    expect(await store.listNotifications({ recipientOpenId: added })).toHaveLength(0);
    await store.enqueueNotifications([notification(id, added)], at(103));
    expect(await store.takeNextNotification(at(104))).toBeNull();
    expect((await store.listNotifications({ recipientOpenId: added }))[0].status).toBe('manual_reconciliation');
  });

  it('a delayed original resolver cannot move the boundary past a legacy early successful send', async () => {
    await store.enqueueNotifications([resolution(), notification()], at(0));
    const state = disk(), receipt = state.notifications.find((row: any) => row.kind === 'inventory_inbound_completed');
    Object.assign(receipt, { status: 'completed', messageId: 'om_synthetic_early', sendOutcome: 'delivered', firstSendAttemptAt: at(1).toISOString(), completedAt: at(2).toISOString() });
    await restart(state);
    await store.enqueueNotifications([notification(id, added)], at(3));
    const resolver = await store.takeNextNotification(at(4), undefined, ['inventory_inbound_completed_resolution']);
    await store.completeInboundCompletedResolutionAndEnqueueNotifications(resolver!.key, resolver!.claimToken, [notification(), notification(id, added)], at(5));
    const snapshot = inboundCompletionSnapshot(await store.listNotifications(), id, 'inventory_inbound_completed');
    expect(snapshot.sealedAt).toBe(at(1).toISOString());
    expect(snapshot.notifications.map(row => row.recipientOpenId)).toEqual([old]);
    expect(await store.takeNextNotification(at(6))).toBeNull();
    expect((await store.listNotifications({ recipientOpenId: added }))[0].status).toBe('manual_reconciliation');
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });
});
