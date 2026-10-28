import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { createProcessLockOwner } from '../../server/common/process-lock-owner';
import { nextStocktakeGenerationAt } from '../../server/modules/inventory-management/inventory-stocktake.rules';

describe('monthly stocktake generation', () => {
  let root: string;
  const principal = { role: 'admin', purchaseBuilding: null };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-stocktake-generation-'));
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
  function setup() {
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    const item = {
      recordId: 'stock-a',
      sku: 'A',
      building: 'A楼',
      quantity: 12,
      name: '开关',
      location: '货架1',
      unit: '个',
    };
    const source = {
      snapshot: jest.fn().mockResolvedValue({ items: [item], movements: [] }),
    };
    const service = new InventoryStocktakeService(
      store,
      source as any,
      {} as any,
    );
    const file = join(
      __dirname,
      '../../server/modules/inventory-management/inventory-stocktake-generation.service.ts',
    );
    expect(existsSync(file)).toBe(true);
    const Type = require(file).InventoryStocktakeGenerationService;
    const generation = new Type(store, source, service);
    const month = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    const request = { month, clientMutationId: 'generate-test-1' };
    return { store, source, service, generation, month, request, item, Type };
  }
  it('persists acceptance before touching a slow external source, deduplicates, and uses one snapshot', async () => {
    const { store, source, generation, request } = setup();
    let resolve: (value: unknown) => void = () => {};
    source.snapshot.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const accepted = generation.request(request, principal, 'session-test');
    expect(accepted.status).toBe('queued');
    expect(source.snapshot).not.toHaveBeenCalled();
    expect(
      new InventoryStocktakeStore(store.path).read().generationJobs[0].id,
    ).toBe(accepted.id);
    expect(generation.request(request, principal, 'session-test').id).toBe(
      accepted.id,
    );
    const running = generation.runPending();
    await Promise.resolve();
    expect(source.snapshot).toHaveBeenCalledTimes(1);
    resolve({ items: [], movements: [] });
    await running;
    expect(store.read().sheets).toHaveLength(7);
    expect(store.read().generationJobs[0].status).toBe('success');
  });
  it('preserves existing confirmed records and drafts when manually filling missing buildings', async () => {
    const { store, source, generation, service, request, month } = setup();
    const sheet = await service.start(
      { month, building: 'A楼', clientMutationId: 'existing-start-1' },
      principal as any,
      'session-test',
    );
    store.update((state) => {
      state.sheets[0].lines[0].actualQuantity = 11;
      state.sheets[0].lines[0].note = '已录草稿';
      return true;
    });
    const before = JSON.stringify(store.read().sheets[0]);
    source.snapshot.mockClear();
    generation.request(request, principal, 'session-test');
    await generation.runPending();
    expect(JSON.stringify(store.read().sheets[0])).toBe(before);
    expect(store.read().sheets[0].seed).toBe(sheet.seed);
    expect(source.snapshot).toHaveBeenCalledTimes(1);
    source.snapshot.mockClear();
    generation.request(
      { ...request, clientMutationId: 'generate-test-2' },
      principal,
      'session-test',
    );
    await generation.runPending();
    expect(source.snapshot).not.toHaveBeenCalled();
    expect(store.read().sheets).toHaveLength(7);
  });
  it('keeps failures visible and supports a new manual retry without creating fake zero sheets', async () => {
    const { store, source, generation, request } = setup();
    source.snapshot.mockRejectedValueOnce(
      Object.assign(new Error('source timeout'), { code: 'ETIMEDOUT' }),
    );
    generation.request(request, principal, 'session-test');
    await generation.runPending();
    expect(store.read().sheets).toHaveLength(0);
    expect(store.read().generationJobs[0]).toMatchObject({
      status: 'error',
      attempts: 1,
    });
    generation.request(
      { ...request, clientMutationId: 'generate-retry-1' },
      principal,
      'session-test',
    );
    await generation.runPending();
    expect(store.read().sheets).toHaveLength(7);
  });
  it('recovers a dead worker and does not steal a live worker or duplicate overlapping requests', async () => {
    const { store, source, generation, request, Type, service } = setup();
    const accepted = generation.request(request, principal, 'session-test');
    expect(
      generation.request(
        { ...request, clientMutationId: 'overlap-test-1' },
        principal,
        'session-test',
      ).id,
    ).toBe(accepted.id);
    store.update((state) => {
      const job = state.generationJobs[0];
      job.status = 'running';
      job.owner = createProcessLockOwner('live-worker-token');
      return true;
    });
    const other = new Type(store, source, service);
    await other.runPending();
    expect(source.snapshot).not.toHaveBeenCalled();
    store.update((state) => {
      state.generationJobs[0].owner!.processStartedAtMs = 1;
      return true;
    });
    await other.runPending();
    expect(source.snapshot).toHaveBeenCalledTimes(1);
    expect(store.read().sheets).toHaveLength(7);
  });
  it('restricts generated buildings and does not leak job identities from other scopes', async () => {
    const { generation, store, request, month } = setup();
    expect(() =>
      generation.request(
        { ...request, month: '2026-09' },
        principal,
        'session-test',
      ),
    ).toThrow('本月');
    expect(() =>
      generation.request(request, { role: 'guest' }, 'guest'),
    ).toThrow('权限');
    expect(() =>
      generation.request(
        { ...request, clientMutationId: 'x' },
        principal,
        'session-test',
      ),
    ).toThrow('变更号');
    generation.request(
      request,
      { role: 'inventory_admin', purchaseBuilding: 'B楼' },
      'building-b',
    );
    expect(
      store.read().generationJobs[0].buildings.map((x) => x.building),
    ).toEqual(['B楼']);
    expect(
      generation.status(month, {
        role: 'inventory_admin',
        purchaseBuilding: 'A楼',
      }),
    ).toBeNull();
  });
  it('keeps successful buildings when another building cannot match a mandatory movement', async () => {
    const { generation, store, source, request, item } = setup();
    const previous = new Date(Date.now() + 8 * 3600000);
    previous.setUTCDate(1);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    source.snapshot.mockResolvedValueOnce({
      items: [item, { ...item, recordId: 'stock-a2', location: '货架2' }],
      movements: [
        {
          recordId: 'ambiguous-move',
          type: 'outbound',
          building: 'A楼',
          sku: 'A',
          location: '',
          status: '已出库',
          occurredAt: previous.toISOString(),
        },
      ],
    } as any);
    generation.request(request, principal, 'session-test');
    await generation.runPending();
    expect(store.read().sheets).toHaveLength(6);
    expect(
      store
        .read()
        .generationJobs[0].buildings.find((x) => x.building === 'A楼'),
    ).toMatchObject({ status: 'error' });
    expect(
      store
        .read()
        .generationJobs[0].buildings.find((x) => x.building === 'B楼'),
    ).toMatchObject({ status: 'done' });
    const before = JSON.stringify(store.read().sheets);
    generation.request(
      { ...request, clientMutationId: 'fix-match-retry' },
      principal,
      'session-test',
    );
    await generation.runPending();
    expect(store.read().sheets).toHaveLength(7);
    expect(JSON.stringify(store.read().sheets.slice(0, 6))).toBe(before);
  });
  it('runs after the Shanghai monthly deadline and cleans up all timers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T02:29:59+08:00'));
    const { generation, store } = setup();
    await generation.onModuleInit();
    expect(store.read().generationJobs).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.read().generationJobs[0].status).toBe('queued');
    await jest.advanceTimersByTimeAsync(1);
    expect(store.read().sheets).toHaveLength(7);
    await generation.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('keeps an earlier building failure visible in the admin summary after another building succeeds', async () => {
    const { generation, source, request, month } = setup();
    source.snapshot.mockRejectedValueOnce(new Error('source failure'));
    generation.request(
      request,
      { role: 'inventory_admin', purchaseBuilding: 'A楼' },
      'actor-a',
    );
    await generation.runPending();
    generation.request(
      { ...request, clientMutationId: 'generate-building-b' },
      { role: 'inventory_admin', purchaseBuilding: 'B楼' },
      'actor-b',
    );
    await generation.runPending();
    const status = generation.status(month, principal);
    expect(status.buildings.find((b: any) => b.building === 'A楼').status).toBe(
      'error',
    );
    expect(status.status).toBe('error');
    expect(status.buildings.find((b: any) => b.building === 'B楼').status).toBe(
      'done',
    );
  });
  it('catches up the current month on deployment startup and caps automatic retries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-04T12:00:00+08:00'));
    const { generation, source, store } = setup();
    source.snapshot.mockRejectedValue(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );
    await generation.onModuleInit();
    await jest.advanceTimersByTimeAsync(1);
    expect(store.read().generationJobs[0]).toMatchObject({
      month: '2026-10',
      status: 'error',
      attempts: 1,
    });
    await jest.advanceTimersByTimeAsync(240_000);
    expect(store.read().generationJobs[0]).toMatchObject({
      status: 'error',
      attempts: 3,
      retryAt: null,
    });
    expect(source.snapshot).toHaveBeenCalledTimes(3);
    await generation.onModuleDestroy();
  });
  it('computes 02:30 monthly deadlines including year changes independently of host time zone', () => {
    expect(
      nextStocktakeGenerationAt(new Date('2026-09-30T18:29:59Z')).toISOString(),
    ).toBe('2026-09-30T18:30:00.000Z');
    expect(
      nextStocktakeGenerationAt(new Date('2026-09-30T18:30:00Z')).toISOString(),
    ).toBe('2026-10-31T18:30:00.000Z');
    expect(
      nextStocktakeGenerationAt(new Date('2026-12-31T18:30:00Z')).toISOString(),
    ).toBe('2027-01-31T18:30:00.000Z');
  });
  it('does not fabricate missed historical sheets from current inventory after a restart', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00+08:00'));
    const { generation, store, source, request } = setup();
    generation.request(request, principal, 'session-test');
    jest.setSystemTime(new Date('2026-11-01T03:00:00+08:00'));
    await generation.runPending();
    expect(source.snapshot).not.toHaveBeenCalled();
    expect(store.read().sheets).toHaveLength(0);
    expect(store.read().generationJobs[0]).toMatchObject({
      status: 'error',
      retryAt: null,
    });
  });
});
