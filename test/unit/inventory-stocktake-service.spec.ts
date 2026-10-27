import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import type { InventoryManagementItem } from '../../shared/inventory-management.interface';

const item = {
  recordId: 'rec1',
  sku: 'SKU1',
  name: '示例',
  building: 'A楼',
  location: '库房',
  quantity: 2,
  unit: '个',
} as InventoryManagementItem;
const person = {
  recordId: 'person1',
  openId: 'ou_person',
  name: '示例人员',
  building: 'A楼',
  employeeNo: '1',
  position: '',
  specialty: '',
};
const actor = { role: 'admin', purchaseBuilding: null };
describe('盘点执行服务', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-stocktake-svc-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function setup() {
    const source = {
      snapshot: jest.fn().mockResolvedValue({ items: [item], movements: [] }),
      current: jest.fn().mockResolvedValue(item),
    };
    const people = {
      resolveApplicantForBuilding: jest.fn().mockResolvedValue(person),
    };
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    const Service =
      require('../../server/modules/inventory-management/inventory-stocktake.service').InventoryStocktakeService;
    const service = new Service(store, source, people);
    const month = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    const start = { month, building: 'A楼', clientMutationId: 'start-0000001' };
    return { service, source, people, store, start };
  }
  async function setupReview() {
    const context = setup();
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...item,
      recordId: `stock-${i}`,
      name: `物品${i}`,
      quantity: 2,
    }));
    context.source.snapshot.mockResolvedValue({ items, movements: [] });
    context.source.current.mockImplementation(async (previous) =>
      items.find((i) => i.recordId === previous.recordId),
    );
    (context.source as any).currentMany = jest.fn().mockResolvedValue(items);
    await context.service.start(context.start, actor, 'session1');
    const sheet = context.service.get(
      context.start.month,
      'A楼',
      actor,
      'review',
    );
    return { ...context, items, sheet };
  }
  it('retries a historical month without reopening business writes or crossing building access', async () => {
    const { service, start, store } = await setupReview();
    store.update((state) => {
      const line = state.sheets[0].review!.lines[0];
      line.sync = {
        version: line.version,
        status: 'error',
        attempts: 3,
        retryAt: null,
        error: 'timeout',
        syncedAt: null,
      };
      return true;
    });
    const future = new Date(`${start.month}-15T00:00:00Z`);
    future.setUTCMonth(future.getUTCMonth() + 1);
    jest.useFakeTimers({ now: future });
    try {
      const request = {
        ...start,
        scope: 'review',
        clientMutationId: 'retry-history-001',
      };
      const sync = {
        kick: jest.fn(),
        summary: jest.fn().mockReturnValue({ pending: 1 }),
      };
      expect(service.retrySync(request, actor, 'session1', sync)).toEqual({
        pending: 1,
      });
      expect(store.read().sheets[0].review!.lines[0].sync).toMatchObject({
        status: 'pending',
        attempts: 0,
        clientMutationId: request.clientMutationId,
      });
      expect(sync.kick).toHaveBeenCalledTimes(1);
      expect(() =>
        service.retrySync(
          request,
          { role: 'inventory_admin', purchaseBuilding: 'B楼' },
          'session1',
          sync,
        ),
      ).toThrow('楼栋');
      await expect(
        service.start(
          { ...request, clientMutationId: 'history-write-001' },
          actor,
          'session1',
        ),
      ).rejects.toThrow('本月');
    } finally {
      jest.useRealTimers();
    }
  });
  it('restores only the latest bulk batch, preserves prior single confirmation and durably queues reversal', async () => {
    const { service, start, sheet, store } = await setupReview();
    const first = sheet.lines[0];
    await service.writeLine(
      {
        ...start,
        scope: 'review',
        clientMutationId: 'single-before-bulk',
        recordId: first.inventory.recordId,
        expectedVersion: first.version,
        actualQuantity: 2,
        confirmer: person,
        note: '',
      },
      actor,
      'session1',
      'confirm',
    );
    const ready = service.get(start.month, 'A楼', actor, 'review');
    const pending = ready.lines.filter((l: any) => l.status === 'draft');
    const confirmed = await service.confirmReview(
      {
        ...start,
        scope: 'review',
        clientMutationId: 'bulk-undo-test-01',
        expectedVersion: ready.version,
        confirmer: person,
        lines: pending.map((l: any) => ({
          recordId: l.inventory.recordId,
          expectedVersion: l.version,
          actualQuantity: null,
          confirmer: null,
          note: '',
        })),
      },
      actor,
      'session1',
    );
    expect(confirmed.latestBulk).toMatchObject({
      count: 17,
      status: 'confirmed',
      confirmer: person,
    });
    const undo = {
      ...start,
      scope: 'review',
      clientMutationId: 'undo-test-00001',
      expectedVersion: confirmed.version,
      batchId: confirmed.latestBulk.id,
    };
    const restored = service.undoReview(undo, actor, 'session1');
    expect(restored.latestBulk.status).toBe('undone');
    expect(restored.lines[1].sync.clientMutationId).toBe('undo-test-00001');
    expect(restored.lines[0].status).toBe('confirmed');
    expect(
      restored.lines
        .slice(1)
        .every(
          (l: any) =>
            l.status === 'draft' &&
            l.actualQuantity === null &&
            l.confirmer === null &&
            l.sync.status === 'pending',
        ),
    ).toBe(true);
    expect(service.undoReview(undo, actor, 'session1')).toEqual(restored);
    expect(
      new InventoryStocktakeStore(store.path).read().sheets[0].review?.lines[1]
        .version,
    ).toBe(3);
  });
  it('freezes complementary lists and keeps review records out of random exclusion history', async () => {
    const { service, start, sheet, items, store } = await setupReview();
    expect(sheet?.scope).toBe('review');
    expect(sheet?.lines).toHaveLength(18);
    const sample = service.get(start.month, 'A楼', actor);
    const sampled = new Set(sample.lines.map((l: any) => l.inventory.recordId));
    expect(
      sheet.lines.every((l: any) => !sampled.has(l.inventory.recordId)),
    ).toBe(true);
    expect(
      new Set(
        [...sample.lines, ...sheet.lines].map((l) => l.inventory.recordId),
      ).size,
    ).toBe(items.length);
    const before = JSON.stringify(store.read().sheets[0]);
    service.generateMissing(start.month, 'A楼', { items, movements: [] });
    expect(JSON.stringify(store.read().sheets[0])).toBe(before);
  });
  it('atomically bulk confirms the entire review list, preserves zero and saved quantities and durably replays', async () => {
    const { service, start, sheet, source, store } = await setupReview();
    const request = {
      ...start,
      scope: 'review',
      expectedVersion: sheet.version,
      clientMutationId: 'bulk-review-001',
      confirmer: person,
      lines: sheet.lines.map((l: any, i: number) => ({
        recordId: l.inventory.recordId,
        expectedVersion: l.version,
        actualQuantity: i === 0 ? 0 : null,
        confirmer: null,
        note: i === 0 ? '实盘为零' : '',
      })),
    };
    const result = await service.confirmReview(request, actor, 'session1');
    expect(result.lines[0].actualQuantity).toBe(0);
    expect(
      result.lines
        .slice(1)
        .every((l: any) => l.actualQuantity === 2 && l.status === 'confirmed'),
    ).toBe(true);
    expect(
      service.overview(start.month, actor).buildings[0].review,
    ).toMatchObject({
      total: 18,
      confirmed: 18,
      shortage: 1,
      surplus: 0,
      matched: 17,
    });
    expect(await service.confirmReview(request, actor, 'session1')).toEqual(
      result,
    );
    expect((source as any).currentMany).toHaveBeenCalledTimes(1);
    expect(
      new InventoryStocktakeStore(store.path).read().sheets[0].review?.lines[0]
        .actualQuantity,
    ).toBe(0);
  });
  it('rejects incomplete scope, stale stock, inactive people and sample bulk operations without partial writes', async () => {
    const { service, start, sheet, source, store, items, people } =
      await setupReview();
    const request = {
      ...start,
      scope: 'review',
      expectedVersion: sheet.version,
      clientMutationId: 'bulk-review-002',
      confirmer: person,
      lines: sheet.lines.map((l: any) => ({
        recordId: l.inventory.recordId,
        expectedVersion: l.version,
        actualQuantity: null,
        confirmer: null,
        note: '',
      })),
    };
    await expect(
      service.confirmReview({ ...request, scope: 'sample' }, actor, 'session1'),
    ).rejects.toThrow('核盘');
    await expect(
      service.confirmReview(
        { ...request, lines: request.lines.slice(1) },
        actor,
        'session1',
      ),
    ).rejects.toThrow('清单');
    await expect(
      service.confirmReview(
        request,
        { role: 'building_admin', purchaseBuilding: 'B楼' },
        'session1',
      ),
    ).rejects.toThrow('楼栋');
    (source as any).currentMany.mockResolvedValue(
      items.map((i) => ({ ...i, quantity: 9 })),
    );
    await expect(
      service.confirmReview(request, actor, 'session1'),
    ).rejects.toThrow('库存已变化');
    (source as any).currentMany.mockResolvedValue(items);
    people.resolveApplicantForBuilding.mockResolvedValue(null);
    await expect(
      service.confirmReview(request, actor, 'session1'),
    ).rejects.toThrow('在职员工');
    expect(
      store.read().sheets[0].review?.lines.every((l) => l.status === 'draft'),
    ).toBe(true);
  });
  it('backfills an old current-month sheet without changing its sample seed or confirmed records', async () => {
    const { service, start, source, store } = setup();
    await service.start(start, actor, 'session1');
    store.update((state) => {
      delete state.sheets[0].review;
      state.sheets[0].lines[0].status = 'confirmed';
      return true;
    });
    const before = JSON.stringify(store.read().sheets[0]);
    service.generateMissing(start.month, 'A楼', {
      items: [item, { ...item, recordId: 'new-remaining' }],
      movements: [],
    });
    const after = store.read().sheets[0];
    expect(after.review?.lines.map((l) => l.inventory.recordId)).toEqual([
      'new-remaining',
    ]);
    const { review, ...sample } = after;
    expect(JSON.stringify(sample)).toBe(before);
    expect(source.snapshot).toHaveBeenCalledTimes(1);
  });
  it('excludes only old sample records when generating the next month, never the review list', async () => {
    const { service, start, items, sheet } = await setupReview();
    jest.useFakeTimers();
    try {
      const next = new Date(`${start.month}-15T12:00:00+08:00`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      jest.setSystemTime(next);
      const month = new Date(next.getTime() + 8 * 3600000)
        .toISOString()
        .slice(0, 7);
      const generated = service.generateMissing(month, 'A楼', {
        items,
        movements: [],
      });
      expect(generated.excludedRecordIds).toHaveLength(2);
      expect(generated.lines).toHaveLength(2);
      const reviewIds = new Set(
        sheet.lines.map((l: any) => l.inventory.recordId),
      );
      expect(
        generated.lines.every((l) => reviewIds.has(l.inventory.recordId)),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
  it('preserves a server draft and a confirmed row, detects a concurrent update, and replays after restart', async () => {
    const { service, start, sheet, source, store, items, people } =
      await setupReview();
    const saved = sheet.lines[0],
      confirmed = sheet.lines[1];
    await service.writeLine(
      {
        ...start,
        scope: 'review',
        recordId: saved.inventory.recordId,
        expectedVersion: 1,
        actualQuantity: 1,
        confirmer: person,
        note: '已暂存少1',
        clientMutationId: 'review-draft-001',
      },
      actor,
      'session1',
      'draft',
    );
    await service.writeLine(
      {
        ...start,
        scope: 'review',
        recordId: confirmed.inventory.recordId,
        expectedVersion: 1,
        actualQuantity: 2,
        confirmer: person,
        note: '',
        clientMutationId: 'review-confirm-001',
      },
      actor,
      'session1',
      'confirm',
    );
    const current = service.get(start.month, 'A楼', actor, 'review');
    const confirmedBytes = JSON.stringify(
      current.lines.find(
        (l: any) => l.inventory.recordId === confirmed.inventory.recordId,
      ),
    );
    const request = {
      ...start,
      scope: 'review',
      expectedVersion: current.version,
      clientMutationId: 'bulk-restart-001',
      confirmer: person,
      lines: current.lines
        .filter((l: any) => l.status === 'draft')
        .map((l: any) => ({
          recordId: l.inventory.recordId,
          expectedVersion: l.version,
          actualQuantity: null,
          confirmer: null,
          note: l.note,
        })),
    };
    const result = await service.confirmReview(request, actor, 'session1');
    expect(
      result.lines.find(
        (l: any) => l.inventory.recordId === saved.inventory.recordId,
      ).actualQuantity,
    ).toBe(1);
    expect(
      JSON.stringify(
        result.lines.find(
          (l: any) => l.inventory.recordId === confirmed.inventory.recordId,
        ),
      ),
    ).toBe(confirmedBytes);
    const Type =
      require('../../server/modules/inventory-management/inventory-stocktake.service').InventoryStocktakeService;
    expect(
      await new Type(
        new InventoryStocktakeStore(store.path),
        source,
        people,
      ).confirmReview(request, actor, 'session1'),
    ).toEqual(result);
    expect((source as any).currentMany).toHaveBeenCalledTimes(1);
  });
  it('aborts an entire batch when a concurrent draft changes during stock verification', async () => {
    const { service, start, sheet, source, store, items } = await setupReview();
    const request = {
      ...start,
      scope: 'review',
      expectedVersion: sheet.version,
      clientMutationId: 'bulk-conflict-01',
      confirmer: person,
      lines: sheet.lines.map((l: any) => ({
        recordId: l.inventory.recordId,
        expectedVersion: l.version,
        actualQuantity: null,
        confirmer: null,
        note: '',
      })),
    };
    (source as any).currentMany.mockImplementation(async () => {
      store.update((state) => {
        state.sheets[0].review!.version++;
        state.sheets[0].review!.lines[0].note = '其他人草稿';
        return true;
      });
      return items;
    });
    await expect(
      service.confirmReview(request, actor, 'session1'),
    ).rejects.toThrow('已更新');
    expect(
      store.read().sheets[0].review?.lines.every((l) => l.status === 'draft'),
    ).toBe(true);
  });
  it('freezes a single monthly list and persists confirmation and completion', async () => {
    const { service, source, people, store, start } = setup();
    const sheet = await service.start(start, actor, 'session1');
    const again = await service.start(
      { ...start, clientMutationId: 'start-0000002' },
      actor,
      'session1',
    );
    expect(again.seed).toBe(sheet.seed);
    expect(source.snapshot).toHaveBeenCalledTimes(1);
    const request = {
      ...start,
      clientMutationId: 'confirm-00001',
      recordId: 'rec1',
      expectedVersion: 1,
      actualQuantity: 1,
      confirmer: person,
      note: '实盘少1个',
    };
    const result = await service.writeLine(
      request,
      actor,
      'session1',
      'confirm',
    );
    expect(result.line.status).toBe('confirmed');
    expect(result.line.confirmer.openId).toBe('ou_person');
    expect(people.resolveApplicantForBuilding).toHaveBeenCalledWith(
      person,
      true,
    );
    expect(
      await service.writeLine(request, actor, 'session1', 'confirm'),
    ).toEqual(result);
    expect(source.current).toHaveBeenCalledTimes(1);
    expect(
      (
        await service.complete(
          { ...start, clientMutationId: 'finish-00001', expectedVersion: 2 },
          actor,
          'session1',
        )
      ).status,
    ).toBe('completed');
    expect(store.read().sheets[0].lines[0].actualQuantity).toBe(1);
  });
  it('rejects unauthorized building, incomplete closure, stale inventory and inactive confirmer', async () => {
    const { service, source, people, start, store } = setup();
    await expect(
      service.start(
        start,
        { role: 'inventory_admin', purchaseBuilding: 'B楼' },
        'session',
      ),
    ).rejects.toThrow('楼栋');
    await service.start(start, actor, 'session1');
    await expect(
      service.complete(
        { ...start, clientMutationId: 'finish-00001', expectedVersion: 1 },
        actor,
        'session1',
      ),
    ).rejects.toThrow('未确认');
    const request = {
      ...start,
      clientMutationId: 'confirm-00001',
      recordId: 'rec1',
      expectedVersion: 1,
      actualQuantity: 2,
      confirmer: person,
      note: '',
    };
    source.current.mockResolvedValue({ ...item, quantity: 3 });
    await expect(
      service.writeLine(request, actor, 'session1', 'confirm'),
    ).rejects.toThrow('库存已变化');
    source.current.mockResolvedValue(item);
    people.resolveApplicantForBuilding.mockResolvedValue(null);
    await expect(
      service.writeLine(request, actor, 'session1', 'confirm'),
    ).rejects.toThrow('在职员工');
    expect(store.read().sheets[0].lines[0].status).toBe('draft');
  });
  it('rejects stale versions and altered idempotency content, preserves a saved draft', async () => {
    const { service, start, store } = setup();
    await service.start(start, actor, 'session1');
    const request = {
      ...start,
      clientMutationId: 'draft-0000001',
      recordId: 'rec1',
      expectedVersion: 1,
      actualQuantity: 0,
      confirmer: person,
      note: '待复点',
    };
    await service.writeLine(request, actor, 'session1', 'draft');
    expect(store.read().sheets[0].lines[0].actualQuantity).toBe(0);
    await expect(
      service.writeLine(
        { ...request, actualQuantity: 1 },
        actor,
        'session1',
        'draft',
      ),
    ).rejects.toThrow('重复变更号');
    await expect(
      service.writeLine(
        { ...request, clientMutationId: 'draft-0000002' },
        actor,
        'session1',
        'draft',
      ),
    ).rejects.toThrow('已更新');
  });
  it('keeps failed generation empty and freezes one sheet during simultaneous starts', async () => {
    const { service, source, start, store } = setup();
    source.snapshot.mockRejectedValueOnce(new Error('source timeout'));
    await expect(service.start(start, actor, 'session1')).rejects.toThrow(
      'source timeout',
    );
    expect(store.read().sheets).toHaveLength(0);
    const [first, second] = await Promise.all([
      service.start(start, actor, 'session1'),
      service.start(
        { ...start, clientMutationId: 'start-parallel-2' },
        actor,
        'session1',
      ),
    ]);
    expect(first.seed).toBe(second.seed);
    expect(store.read().sheets).toHaveLength(1);
  });
  it('refreshes changed inventory while preserving a draft and then confirms against the new balance', async () => {
    const { service, source, start, store } = setup();
    await service.start(start, actor, 'session1');
    const request = {
      ...start,
      recordId: 'rec1',
      expectedVersion: 1,
      actualQuantity: 3,
      confirmer: person,
      note: '',
      clientMutationId: 'refresh-test-1',
    };
    source.current.mockResolvedValue({ ...item, quantity: 3 });
    const refreshed = await service.writeLine(
      request,
      actor,
      'session1',
      'refresh',
    );
    expect(refreshed.line.inventory.quantity).toBe(3);
    expect(refreshed.line.actualQuantity).toBeNull();
    await service.writeLine(
      { ...request, expectedVersion: 2, clientMutationId: 'confirm-new-1' },
      actor,
      'session1',
      'confirm',
    );
    expect(store.read().sheets[0].lines[0].status).toBe('confirmed');
  });
});
