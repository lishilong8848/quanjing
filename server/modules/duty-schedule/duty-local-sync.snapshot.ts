import { randomUUID, createHash } from 'node:crypto';
import { readFile, open, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BitableRecordItem, PersistedBitableRecordSnapshot } from '../../common/feishu/bitable-direct-read';

export interface DutySyncRange { startDate: string; endDate: string; months: string[]; }
export function dutyThreeMonthRange(now = new Date()): DutySyncRange {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find(p => p.type === 'year')!.value), month = Number(parts.find(p => p.type === 'month')!.value) - 1;
  const months = [-1, 0, 1].map(offset => new Date(Date.UTC(year, month + offset, 1)).toISOString().slice(0, 7));
  return { months, startDate: months[0] + '-01', endDate: new Date(Date.UTC(year, month + 2, 0)).toISOString().slice(0, 10) };
}
export interface DutyMonthSnapshot extends PersistedBitableRecordSnapshot { sourceStartedAt: number; invalidationToken: string | null; }
interface Position { month: string | null; sourceStartedAt: number; invalidationToken: string | null; }
interface Store { version: 1; appToken: string; tableId: string; months: Record<string, DutyMonthSnapshot>; positions: Record<string, Position>; }
const MAX_BYTES = 64 * 1024 * 1024;

/** Separate month publications never overwrite or truncate the historical full-table cache. */
export class DutyLocalMonthSnapshots {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private readonly directory = resolve(process.env.FEISHU_LOCAL_CACHE_DIR?.trim() || join(process.cwd(), 'data', 'feishu-bitable-cache'), 'duty-local-sync')) {}
  private file(appToken: string, tableId: string): string { return join(this.directory, createHash('sha256').update(appToken + '\0' + tableId).digest('hex') + '.json'); }
  private async read(appToken: string, tableId: string): Promise<Store> {
    try {
      const file = this.file(appToken, tableId), size = (await stat(file)).size;
      if (size > MAX_BYTES) throw new Error('LOCAL_SYNC_SNAPSHOT_TOO_LARGE');
      const value = JSON.parse(await readFile(file, 'utf8')) as Store;
      if (value.version !== 1 || value.appToken !== appToken || value.tableId !== tableId || !value.months || Array.isArray(value.months) || !value.positions || Array.isArray(value.positions) ||
          !Object.values(value.positions).every(position => position && (position.month === null || /^\d{4}-\d{2}$/.test(position.month)) && Number.isFinite(position.sourceStartedAt) && (position.invalidationToken === null || typeof position.invalidationToken === 'string')) ||
          !Object.entries(value.months).every(([month, row]) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && row && Array.isArray(row.records) &&
            Number.isFinite(row.sourceStartedAt) && Number.isFinite(row.fetchedAt) && Number.isFinite(row.expiresAt) && (row.invalidationToken === null || typeof row.invalidationToken === 'string'))) throw new Error('LOCAL_SYNC_SNAPSHOT_INVALID');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, appToken, tableId, months: {}, positions: {} };
      throw error;
    }
  }
  async readMonth(appToken: string, tableId: string, month: string): Promise<DutyMonthSnapshot | undefined> { return (await this.read(appToken, tableId)).months[month]; }
  async readPreferredMonth(appToken: string, tableId: string, month: string, full: PersistedBitableRecordSnapshot | null, invalidationToken: string | null): Promise<PersistedBitableRecordSnapshot | null> {
    const state = await this.read(appToken, tableId), selected = preferDutyMonthSnapshot(full, state.months[month], invalidationToken);
    if (!selected) return null;
    const startedAt = selected.sourceStartedAt ?? selected.fetchedAt;
    return { ...selected, records: selected.records.filter(record => {
      const position = state.positions[record.record_id || record.id || ''];
      return !position || position.invalidationToken !== invalidationToken || position.sourceStartedAt < startedAt || position.month === month;
    }) };
  }
  async publish(appToken: string, tableId: string, range: DutySyncRange, records: BitableRecordItem[], sourceStartedAt: number, invalidationToken: string | null, dateOf: (record: BitableRecordItem) => string | null): Promise<number> {
    const file = this.file(appToken, tableId), previous = this.writes.get(file) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const state = await this.read(appToken, tableId), byMonth = new Map(range.months.map(month => [month, [] as BitableRecordItem[]])), ids = new Set<string>();
      for (const record of records) {
        const date = dateOf(record), id = record.record_id || record.id;
        if (!date || date < range.startDate || date > range.endDate || !byMonth.has(date.slice(0, 7)) || !id || ids.has(id)) throw new Error('LOCAL_SYNC_RANGE_INVALID');
        ids.add(id); byMonth.get(date.slice(0, 7))!.push(record);
      }
      const fetchedAt = Date.now();
      const positions = new Map(Object.entries(state.positions));
      for (const [id, position] of positions) if (position.month && range.months.includes(position.month) && !ids.has(id) && position.sourceStartedAt <= sourceStartedAt) {
        positions.set(id, { month: null, sourceStartedAt, invalidationToken });
      }
      for (const [month, rows] of byMonth) for (const record of rows) {
        const id = record.record_id || record.id!;
        if (!positions.has(id) || positions.get(id)!.sourceStartedAt <= sourceStartedAt) positions.set(id, { month, sourceStartedAt, invalidationToken });
      }
      state.positions = Object.fromEntries(positions);
      for (const [month, rows] of byMonth) {
        if (state.months[month]?.sourceStartedAt > sourceStartedAt) throw new Error('LOCAL_SYNC_NEWER_SNAPSHOT_EXISTS');
        state.months[month] = { records: rows, sourceStartedAt, invalidationToken, fetchedAt, expiresAt: fetchedAt + 4 * 60 * 60_000 };
      }
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('LOCAL_SYNC_SNAPSHOT_TOO_LARGE');
      await mkdir(this.directory, { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      if (await readFile(file, 'utf8') !== bytes) throw new Error('LOCAL_SYNC_SNAPSHOT_NOT_PERSISTED');
      return fetchedAt;
    });
    this.writes.set(file, operation);
    try { return await operation; } finally { if (this.writes.get(file) === operation) this.writes.delete(file); }
  }
}

export function preferDutyMonthSnapshot(full: PersistedBitableRecordSnapshot | null, month?: DutyMonthSnapshot, invalidationToken: string | null = null): PersistedBitableRecordSnapshot | null {
  return month && month.invalidationToken === invalidationToken && (!full || month.sourceStartedAt >= (full.sourceStartedAt ?? full.fetchedAt)) ? month : full;
}
