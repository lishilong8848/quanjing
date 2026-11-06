import { randomUUID, createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { readFile, open, mkdir, rename, rm, stat, link } from 'node:fs/promises';
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
const MAX_CACHED_FULL_MONTHS = 24;
const sharedSnapshotWrites = new Map<string, Promise<unknown>>();

function fileStamp(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

function freezeParsedSnapshot(value: object): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeParsedSnapshot(child);
  }
  Object.freeze(value);
}

/** Only plain, deeply frozen data can safely be reused across requests. */
function isDeeplyFrozenSnapshot(value: object): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  try {
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === 'function' || typeof current === 'symbol') return false;
      if (!current || typeof current !== 'object') continue;
      if (seen.has(current)) continue;
      seen.add(current);
      if (!Object.isFrozen(current)) return false;
      const prototype = Object.getPrototypeOf(current);
      if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return false;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) return false;
        pending.push(descriptor.value);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Separate month publications never overwrite or truncate the historical full-table cache. */
export class DutyLocalMonthSnapshots {
  private writes = sharedSnapshotWrites;
  private reads = new Map<string, Promise<Store | null>>();
  private cachedStore?: { file: string; stamp: string; state: Store };
  private cachedHistory?: { file: string; stamp: string; snapshot: PersistedBitableRecordSnapshot };
  private preferredMonths = new WeakMap<DutyMonthSnapshot, PersistedBitableRecordSnapshot>();
  private checkedFullSnapshots = new WeakMap<PersistedBitableRecordSnapshot, boolean>();
  private preferredFull?: { source: PersistedBitableRecordSnapshot; state: Store; invalidationToken: string | null; months: Map<string, PersistedBitableRecordSnapshot> };
  constructor(private readonly directory = resolve(process.env.FEISHU_LOCAL_CACHE_DIR?.trim() || join(process.cwd(), 'data', 'feishu-bitable-cache'), 'duty-local-sync')) {}
  private file(appToken: string, tableId: string): string { return join(this.directory, createHash('sha256').update(appToken + '\0' + tableId).digest('hex') + '.json'); }
  private async read(appToken: string, tableId: string): Promise<Store> {
    const file = this.file(appToken, tableId);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const stats = await stat(file, { bigint: true });
        if (stats.size > BigInt(MAX_BYTES)) throw new Error('LOCAL_SYNC_SNAPSHOT_TOO_LARGE');
        const stamp = fileStamp(stats);
        const cached = this.cachedStore;
        if (cached?.file === file && cached.stamp === stamp) return cached.state;

        const key = file + '\0' + stamp;
        let operation = this.reads.get(key);
        if (!operation) {
          operation = this.load(file, stamp, appToken, tableId).finally(() => this.reads.delete(key));
          this.reads.set(key, operation);
        }
        const state = await operation;
        if (state) return state;
      }
      throw new Error('LOCAL_SYNC_SNAPSHOT_CHANGED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.cachedStore?.file === file && this.cachedStore.stamp === 'missing') return this.cachedStore.state;
        const empty: Store = { version: 1, appToken, tableId, months: {}, positions: {} };
        freezeParsedSnapshot(empty);
        this.cachedStore = { file, stamp: 'missing', state: empty };
        return empty;
      }
      if (this.cachedStore?.file === file) this.cachedStore = undefined;
      throw error;
    }
  }

  private async load(file: string, stamp: string, appToken: string, tableId: string): Promise<Store | null> {
    const raw = await readFile(file, 'utf8');
    // A different writer can replace the file while the cold read is in flight.
    if (fileStamp(await stat(file, { bigint: true })) !== stamp) return null;
    const value = JSON.parse(raw) as Store;
    if (value.version !== 1 || value.appToken !== appToken || value.tableId !== tableId || !value.months || Array.isArray(value.months) || !value.positions || Array.isArray(value.positions) ||
        !Object.values(value.positions).every(position => position && (position.month === null || /^\d{4}-\d{2}$/.test(position.month)) && Number.isFinite(position.sourceStartedAt) && (position.invalidationToken === null || typeof position.invalidationToken === 'string')) ||
        !Object.entries(value.months).every(([month, row]) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && row && Array.isArray(row.records) &&
          Number.isFinite(row.sourceStartedAt) && Number.isFinite(row.fetchedAt) && Number.isFinite(row.expiresAt) && (row.invalidationToken === null || typeof row.invalidationToken === 'string'))) throw new Error('LOCAL_SYNC_SNAPSHOT_INVALID');
    freezeParsedSnapshot(value);
    this.cachedStore = { file, stamp, state: value };
    return value;
  }

  async readMonth(appToken: string, tableId: string, month: string): Promise<DutyMonthSnapshot | undefined> {
    const snapshot = (await this.read(appToken, tableId)).months[month];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  /** Historical baseline is display-only and is never accepted by strict reads. */
  async preserveHistory(appToken: string, tableId: string, full: PersistedBitableRecordSnapshot | null): Promise<void> {
    if (!full) return;
    const file = this.file(appToken, tableId) + '.history.json';
    if (await this.readHistory(appToken, tableId)) return;
    const bytes = JSON.stringify({ appToken, tableId, snapshot: full });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('LOCAL_SYNC_SNAPSHOT_TOO_LARGE');
    await mkdir(this.directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await rm(temporary, { force: true }); }
  }

  async readHistoricalMonth(appToken: string, tableId: string, month: string, full: PersistedBitableRecordSnapshot | null): Promise<PersistedBitableRecordSnapshot | null> {
    const monthly = (await this.read(appToken, tableId)).months[month];
    const historical = await this.readHistory(appToken, tableId) || full;
    return monthly && (!historical || monthly.sourceStartedAt >= (historical.sourceStartedAt ?? historical.fetchedAt)) ? monthly : historical;
  }

  private async readHistory(appToken: string, tableId: string): Promise<PersistedBitableRecordSnapshot | null> {
    const file = this.file(appToken, tableId) + '.history.json';
    try {
      const stats = await stat(file, { bigint: true });
      if (stats.size > BigInt(MAX_BYTES)) throw new Error('LOCAL_SYNC_SNAPSHOT_TOO_LARGE');
      const stamp = fileStamp(stats);
      if (this.cachedHistory?.file === file && this.cachedHistory.stamp === stamp) return this.cachedHistory.snapshot;
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (fileStamp(await stat(file, { bigint: true })) !== stamp) throw new Error('LOCAL_SYNC_SNAPSHOT_CHANGED');
      if (saved.appToken !== appToken || saved.tableId !== tableId || !Array.isArray(saved.snapshot?.records) || !Number.isFinite(saved.snapshot?.fetchedAt)) throw new Error('LOCAL_SYNC_SNAPSHOT_INVALID');
      freezeParsedSnapshot(saved.snapshot);
      this.cachedHistory = { file, stamp, snapshot: saved.snapshot };
      return saved.snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Reuse results only while their complete source and position data are immutable. */
  async readPreferredMonth(appToken: string, tableId: string, month: string, full: PersistedBitableRecordSnapshot | null, invalidationToken: string | null): Promise<PersistedBitableRecordSnapshot | null> {
    const state = await this.read(appToken, tableId);
    const monthSnapshot = state.months[month];
    const selected = preferDutyMonthSnapshot(full, monthSnapshot, invalidationToken);
    if (!selected) return null;
    const owned = selected === monthSnapshot;
    const cached = owned ? this.preferredMonths.get(monthSnapshot) : undefined;
    if (cached) return cached;

    let fullCache: typeof this.preferredFull;
    let frozen = !owned ? this.checkedFullSnapshots.get(selected) : false;
    if (!owned && frozen === undefined) {
      frozen = isDeeplyFrozenSnapshot(selected);
      this.checkedFullSnapshots.set(selected, frozen);
    }
    if (!owned && frozen) {
      fullCache = this.preferredFull;
      if (!fullCache || fullCache.source !== selected || fullCache.state !== state || fullCache.invalidationToken !== invalidationToken) {
        fullCache = { source: selected, state, invalidationToken, months: new Map() };
        this.preferredFull = fullCache;
      }
      const previous = fullCache.months.get(month);
      if (previous) {
        fullCache.months.delete(month);
        fullCache.months.set(month, previous);
        return previous;
      }
    }

    const startedAt = selected.sourceStartedAt ?? selected.fetchedAt;
    const preferred = { ...selected, records: selected.records.filter(record => {
      const position = state.positions[record.record_id || record.id || ''];
      return !position || position.invalidationToken !== invalidationToken || position.sourceStartedAt < startedAt || position.month === month;
    }) };
    if (owned || fullCache) {
      Object.freeze(preferred.records);
      Object.freeze(preferred);
    }
    if (owned) {
      this.preferredMonths.set(monthSnapshot, preferred);
    }
    if (fullCache) {
      fullCache.months.set(month, preferred);
      if (fullCache.months.size > MAX_CACHED_FULL_MONTHS) fullCache.months.delete(fullCache.months.keys().next().value!);
    }
    return preferred;
  }
  async publish(appToken: string, tableId: string, range: DutySyncRange, records: BitableRecordItem[], sourceStartedAt: number, invalidationToken: string | null, dateOf: (record: BitableRecordItem) => string | null): Promise<number> {
    const file = this.file(appToken, tableId), previous = this.writes.get(file) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await this.read(appToken, tableId);
      const state = { ...current, months: { ...current.months } };
      const byMonth = new Map(range.months.map(month => [month, [] as BitableRecordItem[]])), ids = new Set<string>();
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
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        if (this.cachedStore?.file === file) this.cachedStore = undefined;
      }
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
