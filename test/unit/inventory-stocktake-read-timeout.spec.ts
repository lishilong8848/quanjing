import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryWorkflowGateway } from '../../server/modules/inventory-management/inventory-workflow.gateway';
import { InventoryStocktakeSource } from '../../server/modules/inventory-management/inventory-stocktake.source';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { InventoryStocktakeBulkService } from '../../server/modules/inventory-management/inventory-stocktake-bulk.service';
import type { StocktakeBulkRequest } from '../../shared/inventory-stocktake.interface';

const principal = { role: 'admin' as const, purchaseBuilding: null };
const person = {
  recordId: 'test-person',
  openId: 'ou_test',
  name: '测试确认人',
  building: 'B楼',
  employeeNo: 'T1',
  position: '',
  specialty: '',
};
describe('400项核盘读取真实 gateway/source/任务链', () => {
  let root: string;
  const originalTable = process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stocktake-read-test-'));
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = 'test-table';
    jest.useFakeTimers({ now: new Date('2026-10-16T02:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
    originalTable === undefined
      ? delete process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID
      : (process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = originalTable);
  });
  async function setup() {
    const items = Array.from({ length: 445 }, (_, i) => ({
      recordId: `test-stock-${i}`,
      sku: `T${i}`,
      name: `测试物品${i}`,
      building: 'B楼',
      quantity: 12,
      location: 'B-315-1-1',
      unit: '个',
    }));
    const raw = (id: string) => ({
      record_id: id,
      fields: {
        楼栋: 'B楼',
        物品类别号: items.find((i) => i.recordId === id)!.sku,
        剩余库存: 12,
        存放位置: 'B-315-1-1',
      },
    });
    let rejected = false;
    const get = jest.fn(async (_url, config) => {
      // Production-shaped slow pagination: six full-table pages exceed the total 30s deadline.
      const timeout = config.timeout;
      await new Promise<void>((resolve, reject) =>
        setTimeout(
          () =>
            timeout < 6000
              ? reject(
                  Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
                )
              : resolve(),
          Math.min(timeout, 6000),
        ),
      );
      return {
        data: {
          code: 0,
          data: {
            items: [],
            has_more: true,
            page_token: `page-${get.mock.calls.length}`,
          },
        },
      };
    });
    const post = jest.fn(
      async (_url: string, body: { record_ids: string[] }) => {
        if (rejected)
          throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return {
          data: { code: 0, data: { records: body.record_ids.map(raw) } },
        };
      },
    );
    const gateway = new InventoryWorkflowGateway({
      axiosRef: { get, post },
    } as never);
    jest
      .spyOn(gateway as any, 'getTenantAccessToken')
      .mockResolvedValue('test-token');
    const source = new InventoryStocktakeSource({} as never, gateway);
    jest
      .spyOn(source as any, 'config')
      .mockResolvedValue({ appToken: 'test-app', url: '' });
    jest
      .spyOn(source, 'snapshot')
      .mockResolvedValue({ items, movements: [] } as never);
    const people = {
      resolveApplicantForBuilding: jest.fn().mockResolvedValue(person),
    };
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    const sheets = new InventoryStocktakeService(
      store,
      source,
      people as never,
    );
    await sheets.start(
      { month: '2026-10', building: 'B楼', clientMutationId: 'test-create' },
      principal,
      'test-session',
    );
    const sheet = sheets.get('2026-10', 'B楼', principal, 'review')!;
    expect(sheet.lines).toHaveLength(400);
    const request: StocktakeBulkRequest = {
      month: '2026-10',
      building: 'B楼',
      scope: 'review',
      expectedVersion: sheet.version,
      clientMutationId: 'test-bulk',
      confirmer: person,
      lines: sheet.lines.map((line) => ({
        recordId: line.inventory.recordId,
        expectedVersion: line.version,
        actualQuantity: null,
        confirmer: null,
        note: '',
      })),
    };
    const worker = new InventoryStocktakeBulkService(store, sheets);
    return {
      worker,
      request,
      store,
      post,
      get,
      source,
      people,
      fail: () => {
        rejected = true;
      },
      recover: () => {
        rejected = false;
      },
    };
  }
  it('confirms 400 targets without full-table pagination and keeps edited zero and idempotent replay', async () => {
    const { worker, request, store, get, post } = await setup();
    request.lines[0].actualQuantity = 0;
    request.lines[0].note = '测试盘亏';
    expect(worker.request(request, principal, 'test-session').status).toBe(
      'queued',
    );
    const work = worker.drain();
    await jest.advanceTimersByTimeAsync(35000);
    await work;
    expect(
      worker.status(
        request.month,
        request.building,
        request.clientMutationId,
        principal,
      ).status,
    ).toBe('success');
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(4);
    expect(
      post.mock.calls.every((call) => call[1].record_ids.length <= 100),
    ).toBe(true);
    expect(store.read().bulkBatches).toHaveLength(1);
    expect(store.read().sheets[0].review!.lines[0].actualQuantity).toBe(0);
    expect(worker.request(request, principal, 'test-session').status).toBe(
      'success',
    );
    expect(post).toHaveBeenCalledTimes(4);
  });
  it('keeps drafts on dependency failure, reports inventory stage and retries the original task once', async () => {
    const { worker, request, store, fail, recover } = await setup();
    fail();
    worker.request(request, principal, 'test-session');
    const work = worker.drain();
    await jest.advanceTimersByTimeAsync(65000);
    await work;
    const error = worker.status(
      request.month,
      request.building,
      request.clientMutationId,
      principal,
    );
    expect(error).toMatchObject({
      status: 'error',
      error: expect.stringContaining('库存核查超时'),
    });
    expect(
      store
        .read()
        .sheets[0].review!.lines.every((line) => line.status === 'draft'),
    ).toBe(true);
    recover();
    worker.request(request, principal, 'test-session');
    const retry = worker.drain();
    await jest.advanceTimersByTimeAsync(10000);
    await retry;
    expect(
      worker.status(
        request.month,
        request.building,
        request.clientMutationId,
        principal,
      ).status,
    ).toBe('success');
    expect(store.read().bulkBatches).toHaveLength(1);
  });
  it('does not confirm partial results if a later batch is forbidden', async () => {
    const { worker, request, store, post } = await setup();
    const read = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => {
      if (post.mock.calls.length === 3) throw { response: { status: 403 } };
      return read(...args);
    });
    worker.request(request, principal, 'test-session');
    const work = worker.drain();
    await jest.advanceTimersByTimeAsync(10000);
    await work;
    expect(
      worker.status(
        request.month,
        request.building,
        request.clientMutationId,
        principal,
      ),
    ).toMatchObject({
      status: 'error',
      error: expect.stringContaining('库存核查'),
    });
    expect(store.read().bulkBatches || []).toHaveLength(0);
    expect(
      store
        .read()
        .sheets[0].review!.lines.every((line) => line.status === 'draft'),
    ).toBe(true);
  });
  it('distinguishes personnel timeout and does not read stock or alter drafts', async () => {
    const { worker, request, store, post, get, people } = await setup();
    people.resolveApplicantForBuilding.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );
    worker.request(request, principal, 'test-session');
    await worker.drain();
    expect(
      worker.status(
        request.month,
        request.building,
        request.clientMutationId,
        principal,
      ),
    ).toMatchObject({
      status: 'error',
      error: expect.stringContaining('人员核查超时'),
    });
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(
      store
        .read()
        .sheets[0].review!.lines.every((line) => line.status === 'draft'),
    ).toBe(true);
  });
});
