import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';

const principal = { role: 'admin', purchaseBuilding: null };
const person = {
  recordId: 'test-person',
  openId: 'ou_test',
  name: '示例人员016',
  building: 'H楼',
  employeeNo: 'T1',
  position: '',
  specialty: '',
};
describe('859条核盘慢读取与持久化受理', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-stocktake-bulk-'));
    jest.useFakeTimers({ now: new Date('2026-10-10T02:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
  async function setup() {
    const items = Array.from({ length: 955 }, (_, i) => ({
      recordId: `test-stock-${i}`,
      name: `测试物品${i}`,
      sku: `T${i}`,
      quantity: 12,
      building: 'H楼',
      location: 'H-315-1-1',
      unit: '个',
    }));
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    const source = {
      snapshot: jest.fn().mockResolvedValue({ items, movements: [] }),
      currentMany: jest.fn().mockResolvedValue(items),
    };
    const people = {
      resolveApplicantForBuilding: jest.fn().mockResolvedValue(person),
    };
    const service = new InventoryStocktakeService(
      store,
      source as any,
      people as any,
    );
    await service.start(
      {
        month: '2026-10',
        building: 'H楼',
        clientMutationId: 'bulk-start-test',
      },
      principal as any,
      'test-session',
    );
    const sheet = service.get('2026-10', 'H楼', principal as any, 'review')!;
    const request = {
      month: '2026-10',
      building: 'H楼',
      scope: 'review',
      expectedVersion: sheet.version,
      clientMutationId: 'bulk-request-test',
      confirmer: person,
      lines: sheet.lines.map((l) => ({
        recordId: l.inventory.recordId,
        expectedVersion: l.version,
        actualQuantity: null,
        confirmer: null,
        note: '',
      })),
    } as any;
    expect(request.lines).toHaveLength(859);
    return { store, service, source, people, request };
  }
  it('reproduces the old 20-second HTTP timeout before the stock check and save finish', async () => {
    const { service, source, store, request } = await setup();
    source.currentMany.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 30000)),
    );
    const result = service
      .confirmReview(request, principal as any, 'test-session')
      .catch(() => 'stock-conflict');
    const response = Promise.race([
      result,
      new Promise((resolve) =>
        setTimeout(() => resolve('client-timeout'), 20000),
      ),
    ]);
    await jest.advanceTimersByTimeAsync(20000);
    expect(await response).toBe('client-timeout');
    expect(
      store.read().sheets[0].review!.lines.every((l) => l.status === 'draft'),
    ).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    await result;
  });
  it('persists 859 rows before any external call, then confirms exactly once after a slow read', async () => {
    const { store, service, source, people, request } = await setup();
    const {
      InventoryStocktakeBulkService,
    } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service');
    const worker = new InventoryStocktakeBulkService(store, service);
    const accepted = worker.request(request, principal, 'test-session');
    expect(accepted.status).toBe('queued');
    expect(source.currentMany).not.toHaveBeenCalled();
    expect(people.resolveApplicantForBuilding).not.toHaveBeenCalled();
    expect(
      new InventoryStocktakeStore(store.path).read().bulkJobs,
    ).toHaveLength(1);
    expect(worker.request(request, principal, 'test-session').id).toBe(
      accepted.id,
    );
    let release!: (value: any) => void;
    source.currentMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = worker.drain();
    await jest.advanceTimersByTimeAsync(21000);
    expect(worker.status('2026-10', 'H楼', accepted.id, principal).status).toBe(
      'running',
    );
    release(
      source.snapshot.mock.results[0]
        ? (await source.snapshot.mock.results[0].value).items
        : [],
    );
    await running;
    expect(worker.status('2026-10', 'H楼', accepted.id, principal).status).toBe(
      'success',
    );
    expect(store.read().bulkBatches).toHaveLength(1);
    expect(
      store
        .read()
        .sheets[0].review!.lines.every(
          (l) => l.status === 'confirmed' && l.actualQuantity === 12,
        ),
    ).toBe(true);
    expect(worker.request(request, principal, 'test-session').status).toBe(
      'success',
    );
  });
  it('preserves zero drafts across restart, protects in-flight writes and rejects altered retries', async () => {
    const { store, service, source, request } = await setup();
    request.lines[0].actualQuantity = 0;
    request.lines[0].note = '测试盘亏';
    const {
      InventoryStocktakeBulkService,
    } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service');
    const worker = new InventoryStocktakeBulkService(store, service);
    const task = worker.request(request, principal, 'test-session');
    expect(() =>
      worker.request(
        { ...request, expectedVersion: 2 },
        principal,
        'test-session',
      ),
    ).toThrow('重复变更号');
    expect(() =>
      worker.request(
        { ...request, clientMutationId: 'another-bulk-task' },
        principal,
        'test-session',
      ),
    ).toThrow('正在处理');
    expect(() =>
      worker.status(task.month, task.building, task.id, {
        role: 'inventory_admin',
        purchaseBuilding: 'A楼',
      }),
    ).toThrow('楼栋');
    const reopened = service.get(
      task.month,
      task.building,
      principal as any,
      'review',
    )!;
    expect(reopened.bulkTask?.id).toBe(task.id);
    expect(reopened.lines[0]).toMatchObject({
      actualQuantity: 0,
      note: '测试盘亏',
    });
    await expect(
      service.writeLine(
        {
          ...request,
          recordId: request.lines[0].recordId,
          expectedVersion: 1,
          actualQuantity: 0,
          note: '测试盘亏',
        },
        principal as any,
        'test-session',
        'draft',
      ),
    ).rejects.toThrow('处理中');
    const restarted = new InventoryStocktakeBulkService(
      new InventoryStocktakeStore(store.path),
      service,
    );
    await restarted.drain();
    expect(
      restarted.status(task.month, task.building, task.id, principal).status,
    ).toBe('success');
    expect(source.currentMany).toHaveBeenCalledTimes(1);
    expect(store.read().sheets[0].review!.lines[0].actualQuantity).toBe(0);
  });
  it('reports stale stock without confirming anything and retries the same failed task', async () => {
    const { store, service, source, request } = await setup();
    const {
      InventoryStocktakeBulkService,
    } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service');
    const worker = new InventoryStocktakeBulkService(store, service);
    const items = (await source.snapshot.mock.results[0].value).items;
    source.currentMany.mockResolvedValueOnce(
      items.map((i: any) => ({ ...i, quantity: 13 })),
    );
    const task = worker.request(request, principal, 'test-session');
    await worker.drain();
    expect(
      worker.status(task.month, task.building, task.id, principal),
    ).toMatchObject({
      status: 'error',
      error: expect.stringContaining('库存已变化'),
    });
    expect(store.read().bulkBatches || []).toHaveLength(0);
    expect(worker.request(request, principal, 'test-session').id).toBe(task.id);
    await worker.drain();
    expect(store.read().bulkBatches).toHaveLength(1);
  });
  it('recovers a dead owner after commit across month rollover without another external read', async () => {
    const { store, service, source, people, request } = await setup();
    const {
      InventoryStocktakeBulkService,
    } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service');
    const worker = new InventoryStocktakeBulkService(store, service);
    const task = worker.request(request, principal, 'test-session');
    await service.confirmReview(request, principal as any, 'test-session');
    store.update((state) => {
      const job = state.bulkJobs![0];
      job.status = 'running';
      job.owner = {
        version: 1,
        pid: 2147483647,
        token: 'dead-owner-token',
        acquiredAt: job.updatedAt,
        processStartedAtMs: 1,
      };
      return true;
    });
    jest.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    source.currentMany.mockClear();
    people.resolveApplicantForBuilding.mockClear();
    await worker.drain();
    expect(
      worker.status(task.month, task.building, task.id, principal).status,
    ).toBe('success');
    expect(source.currentMany).not.toHaveBeenCalled();
    expect(people.resolveApplicantForBuilding).not.toHaveBeenCalled();
    expect(store.read().bulkBatches).toHaveLength(1);
    expect(store.read().bulkJobs![0].request).toBeNull();
  });
});
