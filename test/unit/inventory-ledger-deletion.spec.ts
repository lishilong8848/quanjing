import { ForbiddenException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { InventoryLedgerDeletionStore } from '../../server/modules/inventory-management/inventory-ledger-deletion.store';
import { InventoryLedgerDeletionService } from '../../server/modules/inventory-management/inventory-ledger-deletion.service';
import { InventoryWorkflowRecordDeleteUncertainError } from '../../server/modules/inventory-management/inventory-workflow.gateway';
import type { InventoryLedgerDeletionRequest } from '../../shared/inventory-ledger-deletion.interface';
import { buildStableInventoryMutationFingerprint } from '../../server/modules/inventory-management/inventory-idempotency-fingerprint';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app_test'),
}));
const admin: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const request = (): InventoryLedgerDeletionRequest => ({ clientMutationId: 'ledger-delete-0001', recordId: 'rec_test', building: 'C楼', expected: { sku: 'C100', quantity: 0, location: '' } });
describe('库存台账持久化删除', () => {
  let root: string;
  const env = { ...process.env };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-ledger-delete-'));
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = 'tbl_inventory';
    process.env.FEISHU_WAREHOUSE_CATALOG_TABLE_ID = 'tbl_catalog';
    process.env.FEISHU_WAREHOUSE_APP_TOKEN = 'app_test';
  });
  afterEach(() => { jest.useRealTimers(); rmSync(root, { recursive: true, force: true }); process.env = { ...env }; });
  function setup() {
    let record: any = { record_id: 'rec_test', fields: { '名称': '测试物品', '物品类别号': 'C100', '楼栋': 'C楼', '剩余库存': 0 } };
    const gateway = {
      tryGetRecord: jest.fn(async () => record),
      listRecords: jest.fn().mockResolvedValue([]),
      deleteRecordAndConfirmAbsent: jest.fn(async () => { record = undefined; }),
      invalidateRecordsCache: jest.fn(),
    };
    const store = new InventoryLedgerDeletionStore(join(root, 'deletions.json'));
    const management = { invalidateCache: jest.fn() };
    const create = (targetStore = store, access?: any) => new InventoryLedgerDeletionService(targetStore, gateway as any, {} as any, management as any, access);
    return { gateway, store, management, service: create(), create, setRecord: (value: any) => { record = value; }, getRecord: () => record };
  }
  it('accepts immediately, deletes the exact ledger row once, and keeps an idempotent completed receipt', async () => {
    const s = setup(); const req = request();
    expect((await s.service.accept(req, admin, 'actor-admin')).status).toBe('pending');
    await s.service.waitForIdle();
    expect((await s.service.status(req.clientMutationId, 'actor-admin')).status).toBe('completed');
    await s.service.accept(req, admin, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledWith('app_test', 'tbl_inventory', 'rec_test', '库存台账');
    expect(s.management.invalidateCache).toHaveBeenCalled();
    expect(s.gateway.deleteRecordAndConfirmAbsent.mock.calls.every(row => row.length === 4)).toBe(true);
  });
  it('blocks changed quantity, cross-building rows and unauthorized users without deleting', async () => {
    const s = setup(); s.getRecord().fields['剩余库存'] = 1;
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).message).toContain('已变化');
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    s.getRecord().fields['楼栋'] = 'A楼';
    await s.service.accept({ ...request(), clientMutationId: 'ledger-delete-0002' }, admin, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    await expect(s.service.accept(request(), { role: 'guest', purchaseBuilding: null }, 'actor-guest')).rejects.toThrow('删除权限');
  });
  it('detects changes during lookup and does not delete with a stale confirmation', async () => {
    const s = setup(); let reads = 0;
    s.gateway.tryGetRecord.mockImplementation(async () => ({ ...s.getRecord(), fields: { ...s.getRecord().fields, '剩余库存': reads++ ? 1 : 0 } }));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('failed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });
  it('recovers a lost delete receipt after restart by readback, with no second DELETE', async () => {
    const s = setup();
    s.gateway.deleteRecordAndConfirmAbsent.mockImplementation(async () => { s.setRecord(undefined); throw new InventoryWorkflowRecordDeleteUncertainError('库存台账'); });
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.store.findDeletion(request().clientMutationId))?.task.status).toBe('uncertain');
    const restarted = s.create(new InventoryLedgerDeletionStore(join(root, 'deletions.json')));
    await restarted.status(request().clientMutationId, 'actor-admin'); await restarted.waitForIdle();
    expect((await restarted.status(request().clientMutationId, 'actor-admin')).status).toBe('completed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
  });
  it('resolves an uncertain request whose row still exists without replaying deletion', async () => {
    const s = setup(); s.gateway.deleteRecordAndConfirmAbsent.mockRejectedValue(new InventoryWorkflowRecordDeleteUncertainError('库存台账'));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    await s.service.status(request().clientMutationId, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('failed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
  });
  it('rejects reused identifiers, other actors and a second pending target operation', async () => {
    const s = setup(); let finish: (value: any) => void = () => undefined;
    s.gateway.tryGetRecord.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await s.service.accept(request(), admin, 'actor-admin');
    await expect(s.service.accept({ ...request(), expected: { ...request().expected, quantity: 9 } }, admin, 'actor-admin')).rejects.toThrow('不同内容');
    await expect(s.service.accept({ ...request(), clientMutationId: 'ledger-delete-0002' }, admin, 'actor-admin')).rejects.toThrow('已有删除任务');
    await expect(s.service.status(request().clientMutationId, 'actor-other')).rejects.toThrow('无权');
    finish(undefined); await s.service.waitForIdle();
  });
  it('checks current account authorization before issuing a delete', async () => {
    const s = setup(), service = s.create(s.store, { currentPrincipal: () => undefined });
    await service.accept(request(), { ...admin, accountId: 'disabled-account', authorizationVersion: 1 }, 'actor-admin');
    await service.waitForIdle();
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect((await service.status(request().clientMutationId, 'actor-admin')).message).toContain('权限已变化');
  });
  it('allows configured C-building electrical deletion and rejects another building', async () => {
    const s = setup();
    s.gateway.listRecords.mockResolvedValue([{ record_id: 'catalog', fields: { '物品类别号': 'C100', '楼栋': 'C楼', '专业': '电气' } }]);
    const scoped: AccessPrincipal = { role: 'professional_engineer', purchaseBuilding: 'C楼', specialties: ['电气'],
      personalRules: [{ id: 'inventory-delete-C', module: 'inventory', actions: ['read', 'delete'], buildings: ['C楼'], specialties: ['电气'], effect: 'allow' }] };
    await s.service.accept(request(), scoped, 'actor-scoped'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-scoped')).status).toBe('completed');
    const other = setup(); other.getRecord().fields['楼栋'] = 'A楼';
    other.gateway.listRecords.mockResolvedValue([{ record_id: 'catalog', fields: { '物品类别号': 'C100', '楼栋': 'A楼', '专业': '电气' } }]);
    await other.service.accept({ ...request(), clientMutationId: 'ledger-delete-0002', building: 'A楼' }, scoped, 'actor-scoped'); await other.service.waitForIdle();
    expect(other.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });
  it('rejects invalid data and does not let cache invalidation reverse a completed result', async () => {
    const s = setup();
    await expect(s.service.accept({ ...request(), expected: { ...request().expected, quantity: NaN } }, admin, 'actor-admin')).rejects.toThrow('参数无效');
    s.gateway.invalidateRecordsCache.mockImplementation(() => { throw new Error('cache unavailable'); });
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('completed');
  });
  it('retains uncertain status when the reconciliation read itself fails', async () => {
    const s = setup(); s.gateway.deleteRecordAndConfirmAbsent.mockRejectedValue(new InventoryWorkflowRecordDeleteUncertainError('库存台账'));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    s.gateway.tryGetRecord.mockRejectedValue(new Error('read timed out'));
    await s.service.status(request().clientMutationId, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.store.findDeletion(request().clientMutationId))?.task.status).toBe('uncertain');
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
  });

  it('reads only the selected SKU catalog while preserving the final fresh record check', async () => {
    const s = setup();
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledWith({ appToken: 'app_test', tableId: 'tbl_catalog', tableName: '物品类别',
      searchFilter: { conjunction: 'and', conditions: [{ field_name: '物品类别号', operator: 'is', value: ['C100'] }] } });
    expect(s.gateway.tryGetRecord).toHaveBeenCalledTimes(2);
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
  });

  async function seedLegacyFailure(s: ReturnType<typeof setup>, message = 'timeout of 3681ms exceeded') {
    const req = request();
    await s.store.reserveDeletion({ principal: admin, principalFingerprint: 'actor-admin',
      requestFingerprint: buildStableInventoryMutationFingerprint({ actor: 'actor-admin', request: req }),
      request: req, phase: 'prepared', source: { appToken: 'app_test', tableId: 'tbl_inventory' },
      task: { clientMutationId: req.clientMutationId, recordId: req.recordId, status: 'failed', message, updatedAt: new Date().toISOString() } });
  }

  it('resumes a legacy prepared timeout only after explicit acceptance of the original request', async () => {
    const s = setup(); await seedLegacyFailure(s);
    expect(await s.store.recoverableDeletions()).toEqual([]);
    const old = await s.service.status(request().clientMutationId, 'actor-admin'); await s.service.waitForIdle();
    expect(old).toMatchObject({ status: 'failed', retryable: true, definitelyNotDeleted: true });
    expect(s.gateway.tryGetRecord).not.toHaveBeenCalled();
    expect((await s.service.accept(request(), admin, 'actor-admin')).status).toBe('pending');
    await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('completed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
    expect((await s.store.findDeletion(request().clientMutationId))?.request.clientMutationId).toBe(request().clientMutationId);
  });

  it('does not resume a legacy permission or validation failure with the same request', async () => {
    const s = setup(); await seedLegacyFailure(s, '台账库存已变化，请刷新后重新确认删除');
    expect((await s.service.accept(request(), admin, 'actor-admin')).status).toBe('failed'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).retryable).toBe(false);
    expect(s.gateway.tryGetRecord).not.toHaveBeenCalled(); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('persists the failed read stage and stops after two automatic retries', async () => {
    jest.useFakeTimers(); const s = setup();
    s.gateway.listRecords.mockRejectedValue(Object.assign(new Error('timeout of 1299ms exceeded'), { code: 'ECONNABORTED' }));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    let entry = await s.store.findDeletion(request().clientMutationId);
    expect(entry).toMatchObject({ phase: 'prepared', task: { status: 'pending', stage: 'reading-catalog', retryCount: 1, definitelyNotDeleted: true } });
    expect(entry?.task.nextAttemptAt).toBe(new Date(Date.now() + 1000).toISOString());
    await s.service.status(request().clientMutationId, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(1); // polling cannot bypass backoff
    await jest.advanceTimersByTimeAsync(1000); await s.service.waitForIdle();
    expect((await s.store.findDeletion(request().clientMutationId))?.task.retryCount).toBe(2);
    await jest.advanceTimersByTimeAsync(3000); await s.service.waitForIdle();
    entry = await s.store.findDeletion(request().clientMutationId);
    expect(entry?.task).toMatchObject({ status: 'failed', stage: 'reading-catalog', retryCount: 2, retryable: true, definitelyNotDeleted: true });
    expect(entry?.task.nextAttemptAt).toBeUndefined(); expect(entry?.task.message).toContain('核对物品类别与权限');
    await jest.advanceTimersByTimeAsync(120000); await s.service.status(request().clientMutationId, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(3); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect(s.gateway.invalidateRecordsCache).not.toHaveBeenCalled(); expect(s.management.invalidateCache).not.toHaveBeenCalled();
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(4); // explicit retry, no reset of automatic retry count
    await jest.advanceTimersByTimeAsync(120000); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('recovers a persisted backoff after restart without deleting early or creating a new request', async () => {
    jest.useFakeTimers(); const s = setup();
    s.gateway.listRecords.mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' }));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    await s.service.onModuleDestroy();
    const restarted = s.create(new InventoryLedgerDeletionStore(join(root, 'deletions.json')));
    await restarted.status(request().clientMutationId, 'actor-admin'); await restarted.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999); await restarted.waitForIdle(); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); await restarted.waitForIdle();
    expect((await restarted.status(request().clientMutationId, 'actor-admin')).status).toBe('completed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
  });

  it('revalidates changed quantity and permissions on a prepared retry', async () => {
    jest.useFakeTimers(); const s = setup();
    s.gateway.listRecords.mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' }));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    s.getRecord().fields['剩余库存'] = 5;
    await jest.advanceTimersByTimeAsync(1000); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('failed');
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    const other = setup(); let authorized = true;
    const service = other.create(other.store, { currentPrincipal: () => authorized ? admin : undefined });
    other.gateway.listRecords.mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' }));
    await service.accept(request(), { ...admin, accountId: 'account', authorizationVersion: 1 }, 'actor-admin'); await service.waitForIdle();
    authorized = false; await jest.advanceTimersByTimeAsync(1000); await service.waitForIdle();
    expect((await service.status(request().clientMutationId, 'actor-admin')).retryable).toBe(false);
    expect(other.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('does not rebind a recovered task to a different source table', async () => {
    const s = setup(); await seedLegacyFailure(s); process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = 'another_table';
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).message).toContain('数据源已变化');
    expect(s.gateway.tryGetRecord).not.toHaveBeenCalled(); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('never replays a DELETE when explicit retry only reconciles an uncertain result', async () => {
    const s = setup();
    s.gateway.deleteRecordAndConfirmAbsent.mockRejectedValue(new InventoryWorkflowRecordDeleteUncertainError('库存台账'));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.store.findDeletion(request().clientMutationId))?.phase).toBe('deleting');
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).retryable).toBe(false);
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect(s.gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(1);
  });

  it('marks an issued DELETE as result-unknown until its receipt settles', async () => {
    const s = setup(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    s.gateway.deleteRecordAndConfirmAbsent.mockImplementation(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); s.setRecord(undefined);
    });
    await s.service.accept(request(), admin, 'actor-admin'); await started;
    expect((await s.store.findDeletion(request().clientMutationId))?.task).toMatchObject({ stage: 'deleting', definitelyNotDeleted: false });
    expect(await s.service.status(request().clientMutationId, 'actor-admin')).toMatchObject({ status: 'running', retryable: false, definitelyNotDeleted: false });
    release(); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin')).status).toBe('completed');
  });

  it('does not revive an old failure while another request owns the same target', async () => {
    const s = setup(); await seedLegacyFailure(s);
    const original = (await s.store.findDeletion(request().clientMutationId))!;
    const req = { ...request(), clientMutationId: 'ledger-delete-another' };
    await s.store.reserveDeletion({ ...original, request: req,
      requestFingerprint: buildStableInventoryMutationFingerprint({ actor: 'actor-admin', request: req }),
      task: { ...original.task, clientMutationId: req.clientMutationId, status: 'pending' } });
    await expect(s.service.accept(request(), admin, 'actor-admin')).rejects.toThrow('其他删除任务');
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('never retries a permission rejection even if its text mentions timeout', async () => {
    jest.useFakeTimers(); const s = setup(); s.gateway.listRecords.mockRejectedValue(new ForbiddenException('权限读取超时，请重新登录'));
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect((await s.service.status(request().clientMutationId, 'actor-admin'))).toMatchObject({ status: 'failed', retryable: false, retryCount: 0 });
    await jest.advanceTimersByTimeAsync(5000); await s.service.waitForIdle();
    expect(s.gateway.listRecords).toHaveBeenCalledTimes(1); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('checks current account permission again after the final record read', async () => {
    const s = setup(); let checks = 0;
    const service = s.create(s.store, { currentPrincipal: () => ++checks === 1 ? admin : undefined });
    await service.accept(request(), { ...admin, accountId: 'account', authorizationVersion: 1 }, 'actor-admin'); await service.waitForIdle();
    expect(s.gateway.tryGetRecord).toHaveBeenCalledTimes(2);
    expect((await service.status(request().clientMutationId, 'actor-admin')).message).toContain('权限已变化');
    expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });

  it('completes an already absent target without exposing a retryable failure', async () => {
    const s = setup(); s.setRecord(undefined);
    await s.service.accept(request(), admin, 'actor-admin'); await s.service.waitForIdle();
    expect(await s.service.status(request().clientMutationId, 'actor-admin')).toMatchObject({ status: 'completed', retryable: false, definitelyNotDeleted: false });
    expect(s.gateway.listRecords).not.toHaveBeenCalled(); expect(s.gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
  });
});
