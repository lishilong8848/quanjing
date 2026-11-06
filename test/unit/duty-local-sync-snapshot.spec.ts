import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DutyLocalMonthSnapshots, dutyThreeMonthRange, preferDutyMonthSnapshot } from '../../server/modules/duty-schedule/duty-local-sync.snapshot';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';
const row = (id: string, date: string): BitableRecordItem => ({ record_id: id, fields: { date } });
const dateOf = (record: BitableRecordItem) => String(record.fields?.date || '') || null;
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeSnapshot);
    Object.freeze(value);
  }
  return value;
}
describe('three-month publication with complete historical retention', () => {
  let folder: string, store: DutyLocalMonthSnapshots;
  beforeEach(async () => { folder = await files.mkdtemp(join(tmpdir(), 'duty-local-months-')); store = new DutyLocalMonthSnapshots(folder); });
  afterEach(async () => { jest.restoreAllMocks(); expect(dirname(resolve(folder))).toBe(resolve(tmpdir())); expect(folder).toContain('duty-local-months-'); await files.rm(folder, { recursive: true }); });
  it('uses Shanghai calendar months across a year and leap-year boundary', () => {
    expect(dutyThreeMonthRange(new Date('2025-12-31T16:00:00Z'))).toEqual({ months: ['2025-12', '2026-01', '2026-02'], startDate: '2025-12-01', endDate: '2026-02-28' });
    expect(dutyThreeMonthRange(new Date('2024-01-31T16:00:00Z')).endDate).toBe('2024-03-31');
  });
  it('shares one disk read and one immutable preferred result across cold and warm requests', async () => {
    const range = dutyThreeMonthRange(new Date('2026-10-10'));
    const original = row('old', '2026-10-01');
    await store.publish('app', 'table', range, [original], 100, 'first', dateOf);
    const reader = new DutyLocalMonthSnapshots(folder);
    const diskRead = jest.spyOn(require('node:fs/promises') as typeof files, 'readFile');
    const read = () => reader.readPreferredMonth('app', 'table', '2026-10', null, 'first');
    const [first, second, third] = await Promise.all([read(), read(), read()]);
    expect(first?.records).toEqual([original]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await read()).toBe(first);
    expect(diskRead).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(first?.records[0].fields)).toBe(true);

    const mutableCopy = await reader.readMonth('app', 'table', '2026-10');
    mutableCopy!.records[0].fields!.date = '2026-10-31';
    expect((await read())?.records).toEqual([original]);
    expect(await reader.readPreferredMonth('app', 'table', '2026-10', null, 'changed')).toBeNull();

    await reader.publish('app', 'table', range, [row('new', '2026-10-02')], 200, 'first', dateOf);
    const fresh = await read();
    expect(fresh).not.toBe(first);
    expect(fresh?.records).toEqual([row('new', '2026-10-02')]);
    expect(first?.records).toEqual([original]);
  });

  it('reuses immutable full snapshots only for the same month and source version', async () => {
    const full = freezeSnapshot({ records: [row('history', '2026-08-01')], sourceStartedAt: 10, fetchedAt: 20, expiresAt: 30 });
    const read = (month: string, source = full) => store.readPreferredMonth('app', 'table', month, source, null);
    const first = await read('2026-08');
    expect(await read('2026-08')).toBe(first);
    expect(await read('2026-09')).not.toBe(first);
    expect(await read('2026-08')).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.records)).toBe(true);
    expect(() => first!.records.push(row('changed', '2026-08-02'))).toThrow();

    const newer = freezeSnapshot({ records: [row('new', '2026-08-02')], sourceStartedAt: 11, fetchedAt: 21, expiresAt: 31 });
    const changed = await read('2026-08', newer);
    expect(changed).not.toBe(first);
    expect(changed?.records).toEqual([row('new', '2026-08-02')]);
  });

  it('does not reuse a full snapshot if any nested data can change', async () => {
    const record = row('history', '2026-08-01');
    const full = Object.freeze({ records: Object.freeze([record]) as unknown as BitableRecordItem[], sourceStartedAt: 10, fetchedAt: 20, expiresAt: 30 });
    const read = () => store.readPreferredMonth('app', 'table', '2026-08', full, null);
    const inspection = jest.spyOn(Object, 'isFrozen');
    const first = await read();
    const initialChecks = inspection.mock.calls.length;
    expect(initialChecks).toBeGreaterThan(0);
    expect(await read()).not.toBe(first);
    record.fields!.date = '2026-08-02';
    expect((await read())?.records[0].fields?.date).toBe('2026-08-02');
    expect(inspection).toHaveBeenCalledTimes(initialChecks);
    inspection.mockRestore();
    expect(Object.isFrozen(record)).toBe(false);
  });

  it('checks deep immutability once per source, not on every cache hit', async () => {
    const full = freezeSnapshot({ records: [row('history', '2026-08-01')], sourceStartedAt: 10, fetchedAt: 20, expiresAt: 30 });
    const read = () => store.readPreferredMonth('app', 'table', '2026-08', full, null);
    const inspection = jest.spyOn(Object, 'isFrozen');
    const first = await read();
    const initialChecks = inspection.mock.calls.length;
    expect(initialChecks).toBeGreaterThan(1);
    expect(await read()).toBe(first);
    expect(await read()).toBe(first);
    expect(inspection).toHaveBeenCalledTimes(initialChecks);
  });

  it('treats frozen containers with mutable Map contents as unsafe to cache', async () => {
    const details = new Map([['state', 'old']]);
    const full = freezeSnapshot({ records: [{ record_id: 'history', fields: { details } }], sourceStartedAt: 10, fetchedAt: 20, expiresAt: 30 });
    const read = () => store.readPreferredMonth('app', 'table', '2026-08', full, null);
    const first = await read();
    details.set('state', 'new');
    const after = await read();
    expect(after).not.toBe(first);
    expect((after?.records[0].fields?.details as Map<string, string>).get('state')).toBe('new');
  });

  it('recalculates the full snapshot when positions or the source invalidation version change', async () => {
    const moved = row('moved', '2026-08-15');
    const full = freezeSnapshot({ records: [moved, row('kept', '2026-08-16')], sourceStartedAt: 50, fetchedAt: 60, expiresAt: 70 });
    const read = (token: string | null) => store.readPreferredMonth('app', 'table', '2026-08', full, token);
    const before = await read(null);
    expect(before?.records).toEqual(full.records);
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('moved', '2026-10-15')], 200, 'current', dateOf);
    const afterPublish = await read('current');
    expect(afterPublish).not.toBe(before);
    expect(afterPublish?.records).toEqual([row('kept', '2026-08-16')]);
    expect(await read('current')).toBe(afterPublish);
    const afterInvalidation = await read('other');
    expect(afterInvalidation).not.toBe(afterPublish);
    expect(afterInvalidation?.records).toEqual(full.records);
  });

  it('keeps the number of remembered full-snapshot months bounded', async () => {
    const full = freezeSnapshot({ records: [row('history', '2026-08-01')], sourceStartedAt: 10, fetchedAt: 20, expiresAt: 30 });
    const months = Array.from({ length: 25 }, (_, index) => `${2024 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`);
    const read = (month: string) => store.readPreferredMonth('app', 'table', month, full, null);
    const oldest = await read(months[0]);
    for (const month of months.slice(1)) await read(month);
    const reread = await read(months[0]);
    expect(reread).not.toBe(oldest);
    expect(reread?.records).toEqual(full.records);
  });

  it('does not mix full-snapshot results across table scopes', async () => {
    const full = freezeSnapshot({ records: [row('moved', '2026-08-15')], sourceStartedAt: 50, fetchedAt: 60, expiresAt: 70 });
    await store.publish('app-a', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('moved', '2026-10-15')], 200, 'current', dateOf);
    expect((await store.readPreferredMonth('app-a', 'table', '2026-08', full, 'current'))?.records).toEqual([]);
    expect((await store.readPreferredMonth('app-b', 'table', '2026-08', full, 'current'))?.records).toEqual(full.records);
    expect((await store.readPreferredMonth('app-a', 'table', '2026-08', full, 'current'))?.records).toEqual([]);
  });

  it.each(['replacement', 'in-place update'])('reloads a same-size %s with identical modified time and an observable file-stamp change', async (mode) => {
    const range = dutyThreeMonthRange(new Date('2026-10-10'));
    await store.publish('app', 'table', range, [row('old', '2026-10-01')], 100, null, dateOf);
    const [name] = await files.readdir(folder);
    const file = join(folder, name);
    const fixedTime = new Date('2026-10-10T00:00:00Z');
    await files.utimes(file, fixedTime, fixedTime);
    const before = await files.stat(file, { bigint: true });
    const first = await store.readPreferredMonth('app', 'table', '2026-10', null, null);
    const bytes = (await files.readFile(file, 'utf8')).replaceAll('"old"', '"new"');
    const updatePath = mode === 'replacement' ? file + '.replacement' : file;
    await files.writeFile(updatePath, bytes);
    await files.utimes(updatePath, fixedTime, fixedTime);
    if (mode === 'replacement') await files.rename(updatePath, file);
    const after = await files.stat(file, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    if (mode === 'replacement') expect(after.ino).not.toBe(before.ino);
    else expect(after.ino).toBe(before.ino);

    // A rapid in-place write can share the same Windows ctime tick. Model an
    // observable ctime advance explicitly instead of relying on wall-clock
    // resolution. Stat alone cannot detect external edits preserving every
    // fingerprint field; production publications use atomic replacement.
    const statSpy = mode === 'in-place update'
      ? jest.spyOn(require('node:fs/promises') as typeof files, 'stat')
        .mockResolvedValue({ ...after, ctimeNs: before.ctimeNs + 1n } as never)
      : undefined;
    try {
      const latest = await store.readPreferredMonth('app', 'table', '2026-10', null, null);
      expect(latest).not.toBe(first);
      expect(latest?.records).toEqual([row('new', '2026-10-01')]);
      expect(await store.readPreferredMonth('app', 'table', '2026-10', null, null)).toBe(latest);
    } finally { statSpy?.mockRestore(); }
  });

  it('retries with the new file when another publisher replaces it during a cold read', async () => {
    const range = dutyThreeMonthRange(new Date('2026-10-10'));
    await store.publish('app', 'table', range, [row('old', '2026-10-01')], 100, null, dateOf);
    const [name] = await files.readdir(folder);
    const file = join(folder, name);
    const oldBytes = await files.readFile(file, 'utf8');
    const reader = new DutyLocalMonthSnapshots(folder);
    const realRead = files.readFile;
    const interceptedRead: typeof files.readFile = (async (...args: Parameters<typeof files.readFile>) => {
      const data = await realRead(...args);
      const replacement = file + '.replacement';
      await files.writeFile(replacement, oldBytes.replaceAll('"old"', '"new"'));
      await files.rename(replacement, file);
      return data;
    }) as typeof files.readFile;
    jest.spyOn(require('node:fs/promises') as typeof files, 'readFile').mockImplementationOnce(interceptedRead);

    const first = await reader.readPreferredMonth('app', 'table', '2026-10', null, null);
    expect(first?.records).toEqual([row('new', '2026-10-01')]);
    expect(await reader.readPreferredMonth('app', 'table', '2026-10', null, null)).toBe(first);
  });
  it('updates only the chosen three months, preserving both older month publications and full-table bytes', async () => {
    const full = join(folder, 'full-table-history.fixture'), original = 'synthetic full history untouched'; await files.writeFile(full, original);
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-09-10')), [row('old', '2026-08-10'), row('deleted', '2026-09-01'), row('moved', '2026-09-02')], 100, null, dateOf);
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('moved', '2026-10-02')], 200, null, dateOf);
    expect((await store.readMonth('app', 'table', '2026-08'))?.records).toEqual([row('old', '2026-08-10')]);
    expect((await store.readMonth('app', 'table', '2026-09'))?.records).toEqual([]);
    expect((await store.readMonth('app', 'table', '2026-10'))?.records).toEqual([row('moved', '2026-10-02')]);
    expect((await store.readMonth('app', 'table', '2026-11'))?.records).toEqual([]);
    expect(await files.readFile(full, 'utf8')).toBe(original);
    expect((await new DutyLocalMonthSnapshots(folder).readMonth('app', 'table', '2026-08'))?.records).toHaveLength(1);
  });
  it('does not let an older full scan finishing late override a newer month, but accepts a genuinely newer full scan', async () => {
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [], 200, 'current', dateOf);
    const month = await store.readMonth('app', 'table', '2026-10');
    const olderFull = { records: [row('old', '2026-10-01')], sourceStartedAt: 100, fetchedAt: 300, expiresAt: 400 };
    expect(preferDutyMonthSnapshot(olderFull, month, 'current')).toBe(month);
    const newerFull = { ...olderFull, sourceStartedAt: 250 };
    expect(preferDutyMonthSnapshot(newerFull, month, 'current')).toBe(newerFull);
    expect(preferDutyMonthSnapshot(olderFull, month, 'invalidated')).toBe(olderFull);
  });
  it('keeps cached future months outside the refreshed range readable through the unchanged full snapshot', async () => {
    const december = row('future-december', '2026-12-15'), january = row('future-january', '2027-01-15');
    const full = { records: [row('past', '2026-08-15'), december, january], sourceStartedAt: 100, fetchedAt: 150, expiresAt: 400 };
    const fullFile = join(folder, 'full-table-future.fixture'), original = JSON.stringify(full);
    await files.writeFile(fullFile, original);
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('current', '2026-10-15')], 200, null, dateOf);
    const reloaded = new DutyLocalMonthSnapshots(folder);
    for (const [month, expected] of [['2026-12', december], ['2027-01', january]] as const) {
      expect(await reloaded.readMonth('app', 'table', month)).toBeUndefined();
      const selected = await reloaded.readPreferredMonth('app', 'table', month, full, null);
      expect(selected).toEqual(full);
      expect(selected?.records.filter(record => dateOf(record)?.startsWith(month))).toEqual([expected]);
    }
    expect(await files.readFile(fullFile, 'utf8')).toBe(original);
  });
  it('removes a known moved/deleted record from an older historical month without refetching or overwriting its full snapshot', async () => {
    const old = row('moved', '2026-08-15'), full = { records: [old, row('unrelated', '2026-08-16')], sourceStartedAt: 50, fetchedAt: 500, expiresAt: 600 };
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-09-10')), [old], 100, null, dateOf);
    await store.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('moved', '2026-10-15')], 200, null, dateOf);
    expect((await store.readPreferredMonth('app', 'table', '2026-08', full, null))?.records).toEqual([]);
    const onlyFullStore = new DutyLocalMonthSnapshots(join(folder, 'full-only'));
    await onlyFullStore.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [row('moved', '2026-10-15')], 200, null, dateOf);
    expect((await onlyFullStore.readPreferredMonth('app', 'table', '2026-08', full, null))?.records).toEqual([row('unrelated', '2026-08-16')]);
    await onlyFullStore.publish('app', 'table', dutyThreeMonthRange(new Date('2026-10-10')), [], 300, null, dateOf);
    expect((await onlyFullStore.readPreferredMonth('app', 'table', '2026-08', full, null))?.records).toEqual([row('unrelated', '2026-08-16')]);
    expect(full.records).toEqual([old, row('unrelated', '2026-08-16')]);
  });
  it('retains the previous published month when validation or disk rename fails', async () => {
    const range = dutyThreeMonthRange(new Date('2026-10-10')), original = row('old', '2026-10-01');
    await store.publish('app', 'table', range, [original], 100, null, dateOf);
    await expect(store.publish('app', 'table', range, [row('outside', '2025-01-01')], 200, null, dateOf)).rejects.toThrow('RANGE_INVALID');
    jest.spyOn(require('node:fs/promises') as typeof files, 'rename').mockRejectedValueOnce(Object.assign(Error('synthetic disk failure'), { code: 'EACCES' }));
    await expect(store.publish('app', 'table', range, [row('new', '2026-10-02')], 200, null, dateOf)).rejects.toThrow('synthetic disk failure');
    expect((await store.readMonth('app', 'table', '2026-10'))?.records).toEqual([original]);
  });
});
