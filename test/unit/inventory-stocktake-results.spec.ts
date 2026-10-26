import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { InventoryStocktakeResultsSync } from '../../server/modules/inventory-management/inventory-stocktake-results.sync';
import {
  queueStocktakeResult,
  stocktakeResultFields,
  verifyStocktakeResult,
} from '../../server/modules/inventory-management/inventory-stocktake-results.model';
import { createProcessLockOwner } from '../../server/common/process-lock-owner';

function line(id = 'test-1') {
  return {
    inventory: {
      recordId: id,
      name: '测试物品',
      sku: 'TEST',
      quantity: 2,
      unit: '个',
      building: 'A楼',
      location: 'A-315-4-1',
    },
    version: 1,
    status: 'draft',
    actualQuantity: null,
    confirmer: null,
    note: '',
    confirmedAt: null,
    updatedAt: new Date().toISOString(),
    operatorFingerprint: null,
    reasons: [],
    movementIds: [],
    stockFingerprint: 'test',
  } as any;
}
function sheet(lines: any[], month = '2026-10') {
  return {
    month,
    building: 'A楼',
    status: 'open',
    version: 1,
    createdAt: new Date().toISOString(),
    completedAt: null,
    historyStartedAt: new Date().toISOString(),
    seed: 'test',
    algorithm: 'sha256-rank-v1',
    inventoryCount: lines.length,
    randomTarget: 1,
    shortfall: 0,
    excludedRecordIds: [],
    lines,
  } as any;
}
describe('飞书盘点结果后台同步', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-results-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function setup(lines = [line()]) {
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    store.update((s) => {
      s.sheets.push(sheet(lines));
      return true;
    });
    const remote = new Map<string, string>();
    const gateway = {
      ensureSchema: jest.fn().mockResolvedValue(undefined),
      index: jest.fn(async () => new Map(remote)),
      create: jest.fn(async (ids: string[]) => {
        ids.forEach((id) => remote.set(id, `remote-${id}`));
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sync = new InventoryStocktakeResultsSync(store, gateway as any);
    return { store, gateway, sync, remote };
  }
  it('backfills October legacy rows, skips user blank rows, reuses mapping and recovers after restart', async () => {
    const { store, gateway, sync, remote } = setup();
    remote.set('test-1', 'remote-existing');
    await sync.drain();
    expect(gateway.create).not.toHaveBeenCalled();
    expect(sync.summary('2026-10', 'A楼', 'sample').success).toBe(1);
    const next = new InventoryStocktakeResultsSync(
      new InventoryStocktakeStore(store.path),
      gateway as any,
    );
    await next.drain();
    expect(gateway.update).toHaveBeenCalledTimes(1);
  });
  it('retains a durable creation token after uncertain network result and reconciles without duplicate creation', async () => {
    const { store, gateway, sync, remote } = setup();
    gateway.create.mockImplementationOnce(async (ids) => {
      remote.set(ids[0], 'remote-written');
      throw new Error('网络超时');
    });
    await sync.drain();
    const token = store.read().resultCreation?.token;
    expect(token).toBeTruthy();
    expect(sync.summary('2026-10', 'A楼', 'sample').error).toBe(1);
    store.update((s) => {
      queueStocktakeResult(s.sheets[0].lines[0]);
      return true;
    });
    await new InventoryStocktakeResultsSync(store, gateway as any).drain();
    expect(gateway.create).toHaveBeenCalledTimes(1);
    expect(store.read().resultCreation).toBeNull();
    expect(sync.summary('2026-10', 'A楼', 'sample').success).toBe(1);
  });
  it('does not acknowledge an old confirmation after concurrent reversal and writes the newest state', async () => {
    const { store, gateway, sync } = setup();
    gateway.update.mockImplementationOnce(async () => {
      store.update((s) => {
        const l = s.sheets[0].lines[0];
        l.version++;
        l.lastUndoneAt = new Date().toISOString();
        queueStocktakeResult(l);
        return true;
      });
    });
    await sync.drain();
    expect(gateway.update).toHaveBeenCalledTimes(2);
    expect(store.read().sheets[0].lines[0].sync).toMatchObject({
      status: 'success',
      version: 2,
    });
    expect(gateway.update.mock.calls[1][0][0].fields['2026年10月']).toContain(
      '已撤销',
    );
  });
  it('limits automatic retries, exposes a recoverable error and keeps failed writes durable', async () => {
    const { store, gateway, sync } = setup();
    gateway.update.mockRejectedValue(new Error('权限不足'));
    for (let i = 0; i < 4; i++) {
      store.update((s) => {
        if (s.sheets[0].lines[0].sync)
          s.sheets[0].lines[0].sync!.retryAt = null;
        return true;
      });
      await sync.drain();
    }
    expect(gateway.update).toHaveBeenCalledTimes(3);
    expect(store.read().sheets[0].lines[0].sync).toMatchObject({
      status: 'error',
      attempts: 3,
      error: '权限不足',
    });
  });
  it('respects a live worker owner and never creates over an expired uncertain intent', async () => {
    const { store, gateway, sync } = setup();
    store.update((s) => {
      s.resultSyncOwner = createProcessLockOwner('another-worker-0001');
      return true;
    });
    await sync.drain();
    expect(gateway.index).not.toHaveBeenCalled();
    store.update((s) => {
      s.resultSyncOwner = null;
      s.resultCreation = {
        ids: ['test-1'],
        token: 'old-token-1234',
        startedAt: '2026-01-01T00:00:00Z',
        uncertain: true,
      };
      return true;
    });
    await sync.drain();
    expect(gateway.create).not.toHaveBeenCalled();
    expect(sync.summary('2026-10', 'A楼', 'sample').message).toContain(
      '人工核对',
    );
  });
  it('preserves monthly fields and avoids overwriting latest typed results with an older month', async () => {
    const { store, gateway, sync } = setup();
    store.update((s) => {
      s.sheets.push(sheet([line()], '2026-11'));
      return true;
    });
    await sync.drain();
    expect(gateway.update.mock.calls[0][0][0].fields).toHaveProperty(
      '2026年10月',
    );
    expect(gateway.update.mock.calls[0][0][0].fields).not.toHaveProperty(
      '盘点月份',
    );
    expect(gateway.update.mock.calls[1][0][0].fields).toHaveProperty(
      '盘点月份',
      '2026-11',
    );
    expect(gateway.create).toHaveBeenCalledTimes(1);
  });
  it('adapts typed personnel, zero, gain/loss and verifies semantic readback including undo clearing', () => {
    const l = line();
    l.status = 'confirmed';
    l.actualQuantity = 0;
    l.confirmer = { name: '确认人', employeeNo: '100', openId: 'ou_test' };
    l.confirmedAt = '2026-10-02T00:00:00Z';
    const fields = stocktakeResultFields('2026-10', 'review', l);
    expect(fields).toMatchObject({
      确认人: [{ id: 'ou_test' }],
      实盘数量: 0,
      差异数量: -2,
      盘点结果: '盘亏',
      库房: 'A-315',
    });
    verifyStocktakeResult(fields, {
      ...fields,
      物品名称: [{ text: '测试物品', type: 'text' }],
      确认人: [{ id: 'ou_test', name: '来自飞书' }],
    });
    expect(() =>
      verifyStocktakeResult(fields, {
        ...fields,
        确认人: [{ id: 'ou_wrong' }],
      }),
    ).toThrow('确认人');
    l.status = 'draft';
    l.confirmer = null;
    l.confirmedAt = null;
    const undone = stocktakeResultFields('2026-10', 'review', l);
    expect(undone).toMatchObject({
      确认人: [],
      确认时间: null,
      差异数量: null,
      盘点状态: '待盘',
    });
    verifyStocktakeResult(undone, { ...undone, 确认人: null });
  });
  it('rejects a corrupt persisted sync intent and invalid audit instead of silently recreating records', () => {
    const { store } = setup();
    store.update((s) => {
      s.resultCreation = {
        token: 'corrupt',
        ids: [],
        uncertain: true,
        startedAt: 'invalid',
      };
      return true;
    });
    expect(() => store.read()).toThrow('盘点记录读取失败');
  });
});
