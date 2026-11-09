import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { resolve } from 'node:path';
import { readBitableCacheScopeRevision, readLatestPersistedBitableRecordSnapshot, type BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { LeaveApprovalCacheError } from '../../common/feishu/leave-approval-source';
import { DutyLocalMonthSnapshots, dutyThreeMonthRange, type DutySyncRange } from './duty-local-sync.snapshot';
import type { DutyLocalSyncResult } from '../../../shared/duty-local-sync.interface';
import { describeDutyLocalSyncFailure } from './duty-local-sync.task';
import { assertBitableTableConfig } from '../../common/config/external-services.config';

type Source = { appToken: string; tableId: string; tableName: string };
type Persistence = { requirePersisted: boolean; onPersisted: (snapshot: { sourceStartedAt: number; invalidationToken: string | null }) => void };
interface RunningSync { promise: Promise<DutyLocalSyncResult>; phase: string; listeners: Set<(phase: string) => void>; }
const running = new Map<string, RunningSync>();
const readers = new Map<string, DutyLocalMonthSnapshots>();

export function synchronizeRollingSchedule(options: Source & {
  now?: Date;
  store: DutyLocalMonthSnapshots;
  dateOf: (record: BitableRecordItem) => string | null;
  load: (range: DutySyncRange, persistence: Persistence) => Promise<BitableRecordItem[]>;
  approvalReady: () => Promise<boolean>;
  assertDependenciesCurrent?: () => Promise<void>;
  phase?: (value: string) => void;
}): Promise<DutyLocalSyncResult> {
  assertBitableTableConfig(options.tableName, options.appToken, options.tableId);
  const range = dutyThreeMonthRange(options.now);
  const key = JSON.stringify([resolve(process.env.FEISHU_LOCAL_CACHE_DIR || 'data/feishu-bitable-cache'), options.appToken, options.tableId, range.months]);
  const pending = running.get(key);
  if (pending) {
    if (options.phase) { pending.listeners.add(options.phase); options.phase(pending.phase); }
    return pending.promise;
  }
  const job: RunningSync = { promise: undefined!, phase: 'fetching_sources', listeners: new Set(options.phase ? [options.phase] : []) };
  const phase = (value: string) => { job.phase = value; for (const listener of job.listeners) listener(value); };
  const operation = (async () => {
    const startedAt = Date.now();
    const full = await readLatestPersistedBitableRecordSnapshot({ appToken: options.appToken, tableId: options.tableId, tableName: options.tableName });
    if (full) await options.store.preserveHistory(options.appToken, options.tableId, full);
    for (let attempt = 0; ; attempt++) {
      try {
        // The actual source read owns its generation guard. History preservation
        // precedes it and must not reject a fresh read of a newer generation.
        let sourceStartedAt: number | undefined, revision: string | null = null;
        phase('fetching_sources');
        const records = await options.load(range, { requirePersisted: true, onPersisted: snapshot => { sourceStartedAt = snapshot.sourceStartedAt; revision = snapshot.invalidationToken; } });
        phase('validating_snapshot');
        if (sourceStartedAt === undefined || !await options.approvalReady()) throw new ServiceUnavailableException('排班及审批快照尚未完整保存');
        const assertCurrent = async () => {
          if (await readBitableCacheScopeRevision(options.appToken, options.tableId) !== revision) throw new ConflictException('排班来源已变化，请重新同步');
          await options.assertDependenciesCurrent?.();
        };
        await assertCurrent();
        phase('publishing_snapshot');
        await options.store.publish(options.appToken, options.tableId, range, records, sourceStartedAt, revision, options.dateOf, assertCurrent);
        const published = await Promise.all(range.months.map(month => options.store.readMonth(options.appToken, options.tableId, month)));
        if (published.some(snapshot => !snapshot || snapshot.sourceStartedAt !== sourceStartedAt) || published.reduce((sum, snapshot) => sum + snapshot!.records.length, 0) !== records.length) throw new ServiceUnavailableException('排班本地快照核对失败');
        await assertCurrent();
        phase('completed');
        return { success: true, total: records.length, reset: 0, ruleUpdated: 0, localSynced: records.length, failed: 0, failures: [], durationMs: Date.now() - startedAt,
          message: `近三个月排班已同步，共 ${records.length} 条；其它月份缓存已保留`, scope: 'three_months', range: { startDate: range.startDate, endDate: range.endDate }, rangeCount: records.length, storageMode: 'snapshot' } as DutyLocalSyncResult;
      } catch (error) {
        if (error instanceof LeaveApprovalCacheError || attempt >= 2 || describeDutyLocalSyncFailure(error).kind !== 'source_changed') throw error;
        phase('retrying_sources');
        await new Promise<void>(resolve => setTimeout(resolve, attempt === 0 ? 1_000 : 3_000));
      }
    }
  })().finally(() => { if (running.get(key) === job) running.delete(key); job.listeners.clear(); });
  job.promise = operation;
  running.set(key, job);
  return operation;
}

export async function readRollingScheduleRange(source: Source, startDate: string, endDate: string, options: { historical?: boolean; display?: boolean; now?: Date } = {}) {
  const revision = await readBitableCacheScopeRevision(source.appToken, source.tableId);
  const full = await readLatestPersistedBitableRecordSnapshot(source);
  const readerKey = JSON.stringify([resolve(process.env.FEISHU_LOCAL_CACHE_DIR || 'data/feishu-bitable-cache'), source.appToken, source.tableId]);
  let store = readers.get(readerKey);
  if (!store) { store = new DutyLocalMonthSnapshots(); readers.set(readerKey, store); if (readers.size > 32) readers.delete(readers.keys().next().value!); }
  const current = dutyThreeMonthRange(options.now);
  const snapshots = [];
  const cursor = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`), end = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end || end.getUTCFullYear() - cursor.getUTCFullYear() > 100) throw new Error('排班日期范围无效');
  while (cursor <= end) {
    const month = cursor.toISOString().slice(0, 7);
    const historical = options.historical === true && !current.months.includes(month);
    let snapshot = historical ? await store.readHistoricalMonth(source.appToken, source.tableId, month, full)
      : await store.readPreferredMonth(source.appToken, source.tableId, month, full, revision);
    const degraded = !snapshot && options.display === true;
    if (degraded) snapshot = await store.readMonth(source.appToken, source.tableId, month) || null;
    if (!snapshot || !options.display && !historical && (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= Date.now())) throw new ServiceUnavailableException('排班本地缓存暂不可用，请等待后台同步后重试');
    snapshots.push({ month, snapshot, revision, stale: historical || degraded || snapshot.expiresAt <= Date.now() });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  if (!options.display && await readBitableCacheScopeRevision(source.appToken, source.tableId) !== revision) throw new ConflictException('排班来源已变化，请重新读取');
  return snapshots;
}
