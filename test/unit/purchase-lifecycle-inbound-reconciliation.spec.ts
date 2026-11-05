import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';

describe('lifecycle inbound reconciliation', () => {
  let folder: string, store: PurchaseWorkflowStore;
  let previousAppId: string | undefined;
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID;
    process.env.FEISHU_APP_ID = 'cli_test_app';
    folder = await mkdtemp(join(tmpdir(), 'purchase-lifecycle-inbound-'));
    store = new PurchaseWorkflowStore(join(folder, 'ledger.json'));
    await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-lifecycle-1', recipientOpenId: 'ou_manager', requesterOpenId: 'ou_requester', recordIds: ['rec_done', 'rec_pending', 'rec_unknown', 'rec_error'], flowVersion: 'lifecycle_v1' }, undefined, { appId: 'cli_test_app', recipients: [{ openId: 'ou_manager', fullView: false }], authorityTargets: ['rec_done', 'rec_pending', 'rec_unknown', 'rec_error'].map(recordId => ({ recordId, target: { building: 'H楼' as const } })), authorize: () => {} });
    await store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-legacy-1', recipientOpenId: 'ou_manager', requesterOpenId: 'ou_requester', recordIds: ['rec_legacy'] });
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(folder, { recursive: true, force: true }); if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId; });

  it('repairs only explicitly completed lifecycle records and never repeats an existing resolution', async () => {
    const states: Record<string, string> = { rec_done: '采购完成（已入库）', rec_pending: '物品签收（待入库）', rec_unknown: '未知状态', rec_legacy: '采购完成（已入库）' };
    const gateway = { getExecutionRecordAsApp: jest.fn(async (id: string) => { if (id === 'rec_error') throw new Error('source unavailable'); return { recordId: id, status: states[id] }; }) };
    const service = new PurchaseWorkflowService(gateway as never, store);
    const identity = { appId: 'cli_test_app', batchId: 'purchase-lifecycle-1', recipientOpenId: 'ou_manager' };
    await store.enqueueLifecycleRefresh(identity, 1, () => {});
    await (service as any).recoverLifecycleInbound(5);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalledWith('rec_legacy');
    expect((await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' })).map(row => row.recordId)).toEqual(['rec_done']);
    const resolution = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['inventory_inbound_completed_resolution']);
    await (service as any).resolveInboundCompletedNotification(resolution, new Date());
    expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
    expect(await store.listNotifications({ kind: 'inventory_inbound_completed' })).toEqual([]);
    (service as any).lifecycleInboundCursor = '';
    gateway.getExecutionRecordAsApp.mockClear();
    await (service as any).recoverLifecycleInbound(5);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalledWith('rec_done');
    expect((await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' })).filter(row => row.recordId === 'rec_done')).toHaveLength(1);
    expect((await store.getLifecycleOutbox(identity))?.desiredRevision).toBe(2);
  });

  it('rejects a source reversal at resolution time instead of announcing completion', async () => {
    const gateway = { getExecutionRecordAsApp: jest.fn(async (id: string) => ({ recordId: id, status: '物品签收（待入库）' })) };
    const service = new PurchaseWorkflowService(gateway as never, store);
    await store.enqueueLifecycleInboundReconciliation('rec_pending');
    const resolution = await store.takeNextNotification(new Date(Date.now() + 1000), 60000, ['inventory_inbound_completed_resolution']);
    await expect((service as any).resolveInboundCompletedNotification(resolution, new Date())).rejects.toThrow('尚未确认');
    expect((await store.getNotification(resolution!.key))?.status).toBe('processing');
  });
});
