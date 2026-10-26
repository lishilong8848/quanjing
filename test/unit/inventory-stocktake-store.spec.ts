import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessLockOwner } from '../../server/common/process-lock-owner';

describe('盘点持久化台账', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-stocktake-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const Store = () =>
    require('../../server/modules/inventory-management/inventory-stocktake.store')
      .InventoryStocktakeStore;
  it('provides an empty generation queue for missing and legacy ledgers', () => {
    const path = join(root, 'legacy.json');
    const store = new (Store())(path);
    expect(store.read().generationJobs).toEqual([]);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        historyStartedAt: null,
        sheets: [],
        receipts: [],
      }),
    );
    expect(store.read().generationJobs).toEqual([]);
  });
  it('persists one mutation across instances and rejects a different request reusing it', () => {
    const path = join(root, 'ledger.json'),
      first = new (Store())(path),
      second = new (Store())(path);
    const apply = jest.fn((state: any) => {
      state.historyStartedAt = '2026-10-01';
      return { saved: true };
    });
    expect(first.mutate('mutation-1', 'fingerprint-1', apply)).toEqual({
      saved: true,
    });
    expect(second.mutate('mutation-1', 'fingerprint-1', apply)).toEqual({
      saved: true,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(second.read().historyStartedAt).toBe('2026-10-01');
    expect(() => second.mutate('mutation-1', 'fingerprint-2', apply)).toThrow(
      '重复变更号',
    );
  });
  it('does not persist partial mutation after a validation failure', () => {
    const path = join(root, 'ledger.json'),
      store = new (Store())(path);
    store.mutate('initial-1', 'fp', () => true);
    const original = readFileSync(path, 'utf8');
    expect(() =>
      store.mutate('invalid-1', 'fp', (state: any) => {
        state.historyStartedAt = 'bad';
        throw new Error('版本冲突');
      }),
    ).toThrow('版本冲突');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(store.mutate('valid-1', 'fp', () => true)).toBe(true);
  });
  it('fails closed for corrupt data and never overwrites it', () => {
    const path = join(root, 'ledger.json');
    writeFileSync(path, 'broken');
    const store = new (Store())(path);
    expect(() => store.read()).toThrow('盘点记录');
    expect(() => store.mutate('write-1', 'fp', () => true)).toThrow('盘点记录');
    expect(readFileSync(path, 'utf8')).toBe('broken');
  });
  it('rejects overlapping sample/review records and leaves a corrupt ledger untouched', () => {
    const path = join(root, 'overlap.json');
    const line = {
      inventory: { recordId: 'same' },
      version: 1,
      status: 'draft',
    };
    const bytes = JSON.stringify({
      version: 1,
      historyStartedAt: null,
      receipts: [],
      generationJobs: [],
      sheets: [
        {
          month: '2026-10',
          building: 'A楼',
          version: 1,
          status: 'open',
          lines: [line],
          review: { version: 1, status: 'open', lines: [line] },
        },
      ],
    });
    writeFileSync(path, bytes);
    expect(() => new (Store())(path).read()).toThrow('盘点记录读取失败');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
  it('does not steal an active or malformed lock', () => {
    const path = join(root, 'ledger.json');
    writeFileSync(path + '.lock', 'malformed');
    expect(() =>
      new (Store())(path).mutate('write-1', 'fp', () => true),
    ).toThrow('盘点记录正在处理');
    expect(readFileSync(path + '.lock', 'utf8')).toBe('malformed');
    const active = JSON.stringify(createProcessLockOwner('active-owner-1'));
    writeFileSync(path + '.lock', active);
    expect(() =>
      new (Store())(path).mutate('write-2', 'fp', () => true),
    ).toThrow('盘点记录正在处理');
    expect(readFileSync(path + '.lock', 'utf8')).toBe(active);
  });
  it('recovers a lock whose process identity cannot refer to the current process', () => {
    const path = join(root, 'ledger.json');
    const owner = createProcessLockOwner('dead-owner-1');
    owner.processStartedAtMs = 1;
    writeFileSync(path + '.lock', JSON.stringify(owner));
    expect(new (Store())(path).mutate('recover-1', 'fp', () => true)).toBe(
      true,
    );
  });
});
