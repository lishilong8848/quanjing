import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { AdminOnlyMetadataKey } from '../../server/common/access/unified-access.decorators';

const oldFailure = '采购比价图片缓存暂不可用，请重试原通知任务';

describe('采购比价通知受控恢复', () => {
  let store: PurchaseWorkflowStore;
  let directory: string;
  let file: string;
  let keys: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'purchase-comparison-recovery-'));
    file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file);
    await store.onModuleInit();
    const batch = await store.registerManagerApprovalBatch({
      approvalBatchId: 'purchase-application-recovery-test',
      recipientOpenId: 'ou_manager_one', requesterOpenId: 'ou_requester',
      recordIds: ['rec_one'], managers: [{ openId: 'ou_manager_one', name: 'A' }, { openId: 'ou_manager_two', name: 'B' }],
    });
    keys = batch.batch.managerDeliveries!.map(delivery => delivery.sourceNotificationKey);
    for (const key of keys) {
      const claimed = await store.takeNextManagerApprovalNotification(new Date(), 30000);
      expect(claimed?.key).toBe(key);
      await store.failNotification(key, claimed!.claimToken, new Error(oldFailure));
    }
  });

  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });

  it('保留原任务和 UUID，并发或重复调用只恢复一次', async () => {
    const before = await store.getNotification(keys[0]);
    const results = await Promise.all([
      store.retryFailedComparisonImageNotifications(keys, 'admin_one'),
      store.retryFailedComparisonImageNotifications(keys, 'admin_one'),
    ]);
    expect(results.map(result => result.requeued).sort()).toEqual([0, 2]);
    const after = await store.getNotification(keys[0]);
    expect(after).toMatchObject({ key: before!.key, deliveryUuid: before!.deliveryUuid, deliveryGeneration: before!.deliveryGeneration, status: 'pending', sendOutcome: 'unattempted', attempts: 0 });
    expect(after!.deliveryAudit).toEqual([expect.objectContaining({ action: 'comparison_image_requeued', operatorOpenId: 'admin_one' })]);
  });

  it('预览只读且展示批次与对应接收人，确认后仍重新核验', async () => {
    const before = await readFile(file, 'utf8');
    const preview = await store.retryFailedComparisonImageNotifications(keys, 'admin_one', true);
    expect(preview.requeued).toBe(2);
    expect(preview.candidates.map(item => item.recipientName)).toEqual(['A', 'B']);
    expect(await readFile(file, 'utf8')).toBe(before);
    const ledger = JSON.parse(before);
    ledger.notifications[1].sendOutcome = 'unknown';
    await writeFile(file, JSON.stringify(ledger));
    await expect(store.retryFailedComparisonImageNotifications(keys, 'admin_one')).rejects.toThrow();
    expect((await store.getNotification(keys[0]))!.status).toBe('failed');
  });

  it('恢复后原任务可认领并开始发送，不改变幂等 UUID', async () => {
    const before = await store.getNotification(keys[0]);
    await store.retryFailedComparisonImageNotifications([keys[0]], 'admin_one');
    const claimed = await store.takeNextManagerApprovalNotification(new Date(Date.now() + 1000), 30000);
    expect(claimed!.key).toBe(keys[0]);
    expect(claimed!.deliveryUuid).toBe(before!.deliveryUuid);
    expect(claimed!.sendOutcome).toBe('unattempted');
  });

  it('只修改指定原始任务，保留其他任务无法识别的发送证据', async () => {
    const original = JSON.parse(await readFile(file, 'utf8'));
    original.notifications[1].sendOutcome = 'unknown_future_value';
    original.notifications[1].deliveryAudit = [{ action: 'future_audit', payload: 'keep' }];
    original.futureField = { preserved: true };
    await writeFile(file, JSON.stringify(original));
    await store.retryFailedComparisonImageNotifications([keys[0]], 'admin_one');
    const updated = JSON.parse(await readFile(file, 'utf8'));
    expect(updated.notifications[1]).toEqual(original.notifications[1]);
    expect(updated.futureField).toEqual(original.futureField);
  });

  it.each([
    ['unknown', (ledger: any) => { ledger.notifications[1].sendOutcome = 'unknown'; }],
    ['message', (ledger: any) => { ledger.notifications[1].messageId = 'om_already_sent'; }],
    ['started', (ledger: any) => { ledger.notifications[1].firstSendAttemptAt = new Date().toISOString(); }],
    ['other failure', (ledger: any) => { ledger.notifications[1].lastError = '其他错误'; }],
    ['wrong recipient', (ledger: any) => { ledger.managerApprovalBatches[0].managerDeliveries[1].recipientOpenId = 'ou_other'; }],
    ['delivered', (ledger: any) => { ledger.managerApprovalBatches[0].managerDeliveries[1].messageId = 'om_already_sent'; }],
    ['resolved batch', (ledger: any) => { ledger.managerApprovalBatches[0].state = 'resolved'; }],
    ['processed item', (ledger: any) => { ledger.managerApprovalBatches[0].items[0].status = 'approved'; }],
    ['pending', (ledger: any) => { ledger.notifications[1].status = 'pending'; }],
    ['missing raw outcome', (ledger: any) => { delete ledger.notifications[1].sendOutcome; }],
    ['invalid raw outcome', (ledger: any) => { ledger.notifications[1].sendOutcome = 'unknown_future_value'; }],
    ['invalid raw send time', (ledger: any) => { ledger.notifications[1].firstSendAttemptAt = 'invalid'; }],
    ['missing raw audit', (ledger: any) => { delete ledger.notifications[1].deliveryAudit; }],
    ['invalid raw audit', (ledger: any) => { ledger.notifications[1].deliveryAudit = [{ action: 'unknown' }]; }],
    ['missing raw UUID', (ledger: any) => { delete ledger.notifications[1].deliveryUuid; }],
  ])('拒绝 %s 且整批不写入', async (_label, change) => {
    const ledger = JSON.parse(await readFile(file, 'utf8'));
    change(ledger);
    await writeFile(file, JSON.stringify(ledger));
    await expect(store.retryFailedComparisonImageNotifications(keys, 'admin_one')).rejects.toThrow();
    expect((await store.getNotification(keys[0]))!.status).toBe('failed');
  });

  it('入口声明管理员权限并在方法内部拒绝普通账号', () => {
    const method = PurchaseInventoryController.prototype.retryComparisonImageNotifications;
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, method)).toBe(true);
    const controller = new PurchaseInventoryController(null as never, null as never, null as never, null as never, null as never,
      null as never, { retryFailedComparisonImageNotifications: jest.fn() } as never, null as never, null as never, null as never);
    expect(() => controller.retryComparisonImageNotifications({ accessPrincipal: { role: 'editor', accountId: 'editor' } } as never, { keys })).toThrow();
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, PurchaseInventoryController.prototype.previewComparisonImageNotifications)).toBe(true);
    expect(() => controller.previewComparisonImageNotifications({ accessPrincipal: { role: 'editor', accountId: 'editor' } } as never, { keys })).toThrow();
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://portal.example';
    try {
      const admin = { role: 'admin', accountId: 'admin_one' };
      expect(() => controller.retryComparisonImageNotifications({ accessPrincipal: admin, headers: { origin: 'https://evil.example' } } as never, { keys })).toThrow();
      expect(() => controller.previewComparisonImageNotifications({ accessPrincipal: admin, headers: {} } as never, { keys })).toThrow();
      expect(() => controller.previewComparisonImageNotifications({ accessPrincipal: admin, headers: { origin: 'https://portal.example', 'sec-fetch-site': 'cross-site' } } as never, { keys })).toThrow();
      controller.previewComparisonImageNotifications({ accessPrincipal: admin, headers: { origin: 'https://portal.example' } } as never, { keys });
    } finally { if (previous === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = previous; }
  });
});
