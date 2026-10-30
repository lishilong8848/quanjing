import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DutyLocalMonthSnapshots, dutyThreeMonthRange, preferDutyMonthSnapshot } from '../../server/modules/duty-schedule/duty-local-sync.snapshot';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';
const row = (id: string, date: string): BitableRecordItem => ({ record_id: id, fields: { date } });
const dateOf = (record: BitableRecordItem) => String(record.fields?.date || '') || null;
describe('three-month publication with complete historical retention', () => {
  let folder: string, store: DutyLocalMonthSnapshots;
  beforeEach(async () => { folder = await files.mkdtemp(join(tmpdir(), 'duty-local-months-')); store = new DutyLocalMonthSnapshots(folder); });
  afterEach(async () => { jest.restoreAllMocks(); expect(dirname(resolve(folder))).toBe(resolve(tmpdir())); expect(folder).toContain('duty-local-months-'); await files.rm(folder, { recursive: true }); });
  it('uses Shanghai calendar months across a year and leap-year boundary', () => {
    expect(dutyThreeMonthRange(new Date('2025-12-31T16:00:00Z'))).toEqual({ months: ['2025-12', '2026-01', '2026-02'], startDate: '2025-12-01', endDate: '2026-02-28' });
    expect(dutyThreeMonthRange(new Date('2024-01-31T16:00:00Z')).endDate).toBe('2024-03-31');
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
