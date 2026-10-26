jest.mock('../../server/modules/purchase-inventory/purchase-manager-approval.config', () => ({
  isPurchaseManagerApprovalEnabled: () => true,
  readPurchaseManagerApprovers: () => [{ openId: 'ou_observer', name: 'Synthetic observer' }],
}));
import { Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const session = { accessToken: 'synthetic', openId: 'ou_buyer', userName: 'Synthetic', accessRole: 'admin' as const, authenticationMode: 'delegated-app' as const };
const input = { actualQuantity: 2, actualAmount: 300, paymentAttachmentTokens: [], note: '' };
function record(recordId: string): PurchaseWorkflowRecord {
  return { recordId, requestCode: 'AUDIT', status: '审批通过（待下单）', itemName: 'Synthetic', building: 'H楼',
    requesterOpenId: 'ou_requester', requesterName: 'Synthetic', purchaserOpenId: 'ou_buyer', purchaserName: 'Synthetic',
    purchaseMethod: '综合采购', requestedQuantity: 2, actualQuantity: null, actualAmount: null, paymentAttachmentTokens: [],
    approvalCompleted: true, warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', signerOpenId: '',
    receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [] };
}

describe('order notice recovery isolation', () => {
  const saved = { ...process.env };
  let directory: string, store: PurchaseWorkflowStore, service: PurchaseWorkflowService;
  let warnings: jest.SpyInstance;
  const oldStartedAt = new Date(Date.now() - 120_000).toISOString();
  beforeEach(async () => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.PUBLIC_BASE_URL = 'https://synthetic.example';
    directory = await mkdtemp(join(tmpdir(), 'nt-recovery-isolation-'));
    store = new PurchaseWorkflowStore(join(directory, 'ledger.json'));
  });
  afterEach(async () => {
    service?.onModuleDestroy?.();
    await waitForRecovery();
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
    process.env = { ...saved };
    jest.restoreAllMocks();
  });
  async function waitForRecovery() {
    await (service as unknown as { orderNoticeRecovery?: Promise<void> | null })?.orderNoticeRecovery;
  }
  async function pending(recordId: string) {
    await store.claimCommand({ key: `order:${recordId}`, recordId, action: 'order', fingerprint: `synthetic-${recordId}`,
      expectedResultFingerprint: 'unused-while-pre-state', actorOpenId: 'ou_buyer', accessRole: 'admin', authenticationMode: 'delegated-app',
      startedAt: oldStartedAt, orderNotice: { recipientOpenIds: ['ou_observer'], text: 'Synthetic completed order' } });
  }
  function createService(gateway: object) {
    service = new PurchaseWorkflowService(gateway as never, store);
    const port = service as unknown as { recoverMissingWarehouseInboundNotifications(): Promise<number>; recoverMissingCompletionNotifications(): Promise<number> };
    jest.spyOn(port, 'recoverMissingWarehouseInboundNotifications').mockResolvedValue(0);
    jest.spyOn(port, 'recoverMissingCompletionNotifications').mockResolvedValue(0);
    return service;
  }

  it('scans at most five per task and reaches a recoverable 21st command behind twenty stalled entries', async () => {
    for (let index = 1; index <= 20; index++) await pending(`rec_blocked_${String(index).padStart(2, '0')}`);
    let completed = record('rec_recoverable_21');
    const reads: string[] = [];
    const gateway = {
      getExecutionRecord: jest.fn(async () => ({ ...completed })),
      resolveUser: jest.fn(async () => ({ openId: 'ou_buyer', name: 'Synthetic', positions: ['综合管理'], buildings: [] })),
      updateExecutionRecord: jest.fn(async () => {
        completed = { ...completed, status: '下单完成（待签收）', purchaseCompleted: true, actualQuantity: 2, actualAmount: 300 };
        throw Object.assign(new Error('Synthetic unknown write'), { code: 'ECONNRESET' });
      }),
      getExecutionRecordAsApp: jest.fn(async (recordId: string) => { reads.push(recordId); return recordId === completed.recordId ? { ...completed } : record(recordId); }),
      sendIdempotentTextNotification: jest.fn(async () => 'om_synthetic'),
    };
    createService(gateway);
    await expect(service.order(completed.recordId, session, input)).rejects.toThrow();
    const deferred = (await store.findCommand('order:rec_recoverable_21'))!;
    const now = new Date(Date.parse(deferred.startedAt) + 61_000);
    const roundReads: string[][] = [];
    for (let round = 0; round < 5; round++) {
      const before = reads.length;
      await service.runPendingTasks(20, new Date(now.getTime() + round * 5000));
      await waitForRecovery();
      roundReads.push(reads.slice(before));
      expect(reads.length - before).toBeLessThanOrEqual(5);
    }
    expect(roundReads[1]).not.toEqual(roundReads[0]);
    expect(reads).toContain('rec_recoverable_21');
    expect((await store.findCommand('order:rec_recoverable_21'))?.completedAt).not.toBe('');
    await service.runPendingTasks(20, new Date(now.getTime() + 30_000));
    await waitForRecovery();
    expect(gateway.sendIdempotentTextNotification).toHaveBeenCalledTimes(3);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    console.log(JSON.stringify({ probe: 'queue-starvation-fixed', roundReads, recoverable21Read: reads.includes('rec_recoverable_21') }));
  });

  it('delivers ready inbound work and permits the next tick while one recovery read remains pending', async () => {
    await pending('rec_blocking_read');
    let releaseRead!: (value: PurchaseWorkflowRecord) => void;
    let enteredRead!: () => void;
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    const blocked = new Promise<PurchaseWorkflowRecord>(resolve => { releaseRead = resolve; });
    const gateway = {
      getExecutionRecordAsApp: jest.fn(async (recordId: string) => {
        if (recordId === 'rec_blocking_read') { enteredRead(); return blocked; }
        return { ...record(recordId), status: '到货已签收（待入库）', receiptConfirmed: true, purchaseCompleted: true };
      }),
      sendInteractiveCard: jest.fn(async () => 'om_warehouse_ready'),
    };
    createService(gateway);
    const list = jest.spyOn(store, 'listPendingOrderNoticeCommands');
    const enqueueInbound = (number: number) => store.enqueueNotifications([{ businessEventId: `ready-inbound-${number}`,
      recordId: `rec_ready_inbound_${number}`, recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' }]);
    await enqueueInbound(1);
    const running = service.runPendingTasks(1, new Date());
    await entered;
    try {
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(await running).toMatchObject({ processed: 1, failed: 0 });
      await enqueueInbound(2);
      expect(await service.runPendingTasks(1, new Date())).toMatchObject({ processed: 1, failed: 0 });
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(1);
      expect(gateway.getExecutionRecordAsApp.mock.calls.filter(([id]) => id === 'rec_blocking_read')).toHaveLength(1);
      console.log(JSON.stringify({ probe: 'warehouse-not-blocked', sentBeforeRecoveryReadReleased: gateway.sendInteractiveCard.mock.calls.length }));
    } finally {
      releaseRead(record('rec_blocking_read'));
      await running;
      await waitForRecovery();
    }
  });

  it('stops further recovery reads and CAS commits after module destruction', async () => {
    await pending('rec_first');
    await pending('rec_second');
    let releaseRead!: (value: PurchaseWorkflowRecord) => void;
    let enteredRead!: () => void;
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    const gateway = { getExecutionRecordAsApp: jest.fn(() => { enteredRead(); return new Promise<PurchaseWorkflowRecord>(resolve => { releaseRead = resolve; }); }) };
    createService(gateway);
    const commit = jest.spyOn(store, 'completePendingOrderNoticeCommand');
    const running = service.runPendingTasks(20, new Date());
    await entered;
    try {
      service.onModuleDestroy();
    } finally {
      releaseRead({ ...record('rec_first'), status: '下单完成（待签收）', purchaseCompleted: true });
      await running;
      await waitForRecovery();
    }
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(await store.listNotifications({ kind: 'purchase_order_completed' })).toHaveLength(0);
  });

  it('observes a failed scan and releases the single-task slot for the next tick', async () => {
    await pending('rec_retry');
    const gateway = { getExecutionRecordAsApp: jest.fn(async () => record('rec_retry')) };
    createService(gateway);
    jest.spyOn(store, 'listPendingOrderNoticeCommands').mockRejectedValueOnce(new Error('synthetic scan failure'));
    await service.runPendingTasks(1, new Date());
    await waitForRecovery();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('synthetic scan failure'));
    await service.runPendingTasks(1, new Date());
    await waitForRecovery();
    expect(gateway.getExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });

  it('advances past failed reads rather than revisiting only the first page', async () => {
    for (let index = 1; index <= 6; index++) await pending(`rec_failure_${index}`);
    const gateway = { getExecutionRecordAsApp: jest.fn(async (_recordId: string) => { throw new Error('synthetic read failure'); }) };
    createService(gateway);
    await service.runPendingTasks(20, new Date());
    await waitForRecovery();
    await service.runPendingTasks(20, new Date());
    await waitForRecovery();
    expect(gateway.getExecutionRecordAsApp.mock.calls.map(([id]) => id)).toContain('rec_failure_6');
    expect(gateway.getExecutionRecordAsApp.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('uses the same ordering for mixed-case cursors, deleted cursor entries and wraparound', async () => {
    createService({});
    for (const id of ['rec_b', 'rec_A', 'rec_a']) await pending(id);
    const all = await store.listPendingOrderNoticeCommands(100);
    expect(all.map(entry => entry.recordId)).toEqual(['rec_a', 'rec_A', 'rec_b']);
    const cursor = all[1]!;
    await store.releaseCommandClaim(cursor.key, cursor.fingerprint);
    expect((await store.listPendingOrderNoticeCommands(1, cursor.key))[0]?.recordId).toBe('rec_b');
    expect((await store.listPendingOrderNoticeCommands(1, all[2]!.key))[0]?.recordId).toBe('rec_a');
  });

  it('does not claim, read or send ordinary work after module destruction', async () => {
    await pending('rec_shutdown');
    await store.enqueueNotifications([{ businessEventId: 'shutdown-inbound', recordId: 'rec_shutdown_inbound',
      recipientOpenId: 'ou_warehouse', kind: 'warehouse_inbound' }]);
    const gateway = { getExecutionRecordAsApp: jest.fn(), sendInteractiveCard: jest.fn() };
    createService(gateway);
    const claim = jest.spyOn(store, 'takeNextNotification');
    const scan = jest.spyOn(store, 'listPendingOrderNoticeCommands');
    service.onModuleDestroy();
    expect(await service.runPendingTasks()).toMatchObject({ processed: 0, failed: 0, errors: [] });
    await waitForRecovery();
    expect(claim).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });
});
