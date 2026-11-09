jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  readLatestPersistedBitableRecordSnapshot: jest.fn(), readBitableCacheScopeRevision: jest.fn(), fetchBitableRecords: jest.fn(),
  observePersistedBitableCacheInvalidation: jest.fn(), warmLatestPersistedBitableRecordSnapshotIndex: jest.fn(),
}));
jest.mock('../../server/common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('../../server/common/feishu/leave-approval-source'),
  fetchLeaveApprovalSnapshot: jest.fn(), readCachedLeaveApprovalSnapshot: jest.fn(), refreshVerifiedLeaveApprovalSnapshot: jest.fn(),
  isResolvedLeaveApprovalCacheScope: jest.fn(), readCachedLeaveApprovalSnapshotState: jest.fn(),
}));
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DutyLocalMonthSnapshots } from '../../server/modules/duty-schedule/duty-local-sync.snapshot';
import { synchronizeRollingSchedule, readRollingScheduleRange } from '../../server/modules/duty-schedule/rolling-schedule-sync';
import { readLatestPersistedBitableRecordSnapshot, readBitableCacheScopeRevision, fetchBitableRecords, observePersistedBitableCacheInvalidation } from '../../server/common/feishu/bitable-direct-read';
import { readCachedLeaveApprovalSnapshot, fetchLeaveApprovalSnapshot, refreshVerifiedLeaveApprovalSnapshot, isResolvedLeaveApprovalCacheScope, readCachedLeaveApprovalSnapshotState, LeaveApprovalCacheError } from '../../server/common/feishu/leave-approval-source';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { DutyScheduleAutomationService } from '../../server/modules/duty-schedule/duty-schedule.automation';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';

describe('rolling local schedule synchronization', () => {
  let folder: string;
  const previous = process.env.FEISHU_LOCAL_CACHE_DIR;
  const source = { appToken: 'synthetic', tableId: 'schedule', tableName: '值班排班' };
  beforeEach(async () => {
    jest.clearAllMocks();
    folder = await mkdtemp(join(tmpdir(), 'rolling-schedule-'));
    process.env.FEISHU_LOCAL_CACHE_DIR = folder;
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    jest.mocked(readBitableCacheScopeRevision).mockResolvedValue(null);
    const approval = { verified: true, requests: [] };
    jest.mocked(readCachedLeaveApprovalSnapshot).mockResolvedValue(approval);
    jest.mocked(refreshVerifiedLeaveApprovalSnapshot).mockResolvedValue(approval);
    jest.mocked(fetchLeaveApprovalSnapshot).mockResolvedValue(approval);
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.FEISHU_LOCAL_CACHE_DIR; else process.env.FEISHU_LOCAL_CACHE_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  });
  const row = (id: string, date: string) => ({ record_id: id, fields: { 排班日期: date } });
  const dateOf = (record: any) => record.fields.排班日期;

  it('coalesces background approval recovery by exact scope and stops on shutdown', async () => {
    const previousSmoke = process.env.NANTONG_HOTFIX_SMOKE_MODE;
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    jest.useFakeTimers();
    const service = new BitableSyncService({} as never, {} as never);
    const stop = jest.fn();
    let notify!: (appToken: string, tableId: string) => void;
    jest.mocked(observePersistedBitableCacheInvalidation).mockImplementation(listener => {
      notify = listener;
      return stop;
    });
    jest.mocked(isResolvedLeaveApprovalCacheScope).mockImplementation((appToken, tableId) => appToken === 'base' && ['main', 'details'].includes(tableId));
    jest.mocked(readCachedLeaveApprovalSnapshotState).mockResolvedValue({ snapshot: { verified: false, requests: [] }, approvalFetchedAt: null, shiftDetailFetchedAt: null, failure: 'missing' });
    jest.spyOn(service as any, 'warmLeaveFormLocalSnapshots').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshPersonProfileLocalCache').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshFeishuLocalCache').mockResolvedValue(undefined);
    try {
      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      jest.mocked(refreshVerifiedLeaveApprovalSnapshot).mockClear();
      notify('other', 'main');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(refreshVerifiedLeaveApprovalSnapshot).not.toHaveBeenCalled();
      notify('base', 'main');
      notify('base', 'details');
      await jest.advanceTimersByTimeAsync(999);
      expect(refreshVerifiedLeaveApprovalSnapshot).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(refreshVerifiedLeaveApprovalSnapshot).toHaveBeenCalledTimes(1);
      let rejectRefresh!: (error: Error) => void;
      jest.mocked(refreshVerifiedLeaveApprovalSnapshot).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
      const inFlight = (service as any).refreshLeaveApprovalCache();
      notify('base', 'main');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(refreshVerifiedLeaveApprovalSnapshot).toHaveBeenCalledTimes(2);
      rejectRefresh(new LeaveApprovalCacheError('source_changed'));
      await inFlight;
      await jest.advanceTimersByTimeAsync(0);
      expect(refreshVerifiedLeaveApprovalSnapshot).toHaveBeenCalledTimes(3);
      notify('base', 'main');
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(refreshVerifiedLeaveApprovalSnapshot).toHaveBeenCalledTimes(3);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
      if (previousSmoke === undefined) delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
      else process.env.NANTONG_HOTFIX_SMOKE_MODE = previousSmoke;
    }
  });

  it('does not repeat rolling reads after the shared approval conflict retries are exhausted', async () => {
    const error = new LeaveApprovalCacheError('source_changed');
    const load = jest.fn().mockRejectedValue(error);
    await expect(synchronizeRollingSchedule({ ...source, store: new DutyLocalMonthSnapshots(), dateOf, load, approvalReady: async () => false })).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one source read between manual and scheduled callers, including a year boundary', async () => {
    let release!: () => void;
    const load = jest.fn((range, persistence) => new Promise<any[]>(resolve => { release = () => {
      expect(range.months).toEqual(['2025-12', '2026-01', '2026-02']);
      persistence.onPersisted({ sourceStartedAt: Date.now(), invalidationToken: null }); resolve([row('jan', '2026-01-02')]);
    }; }));
    const options = { ...source, now: new Date('2026-01-02T00:00:00+08:00'), store: new DutyLocalMonthSnapshots(), dateOf, load, approvalReady: async () => true };
    const first = synchronizeRollingSchedule(options), second = synchronizeRollingSchedule({ ...options, store: new DutyLocalMonthSnapshots() });
    expect(second).toBe(first);
    for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    release();
    await expect(first).resolves.toMatchObject({ success: true, localSynced: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('accepts a fresh read after history preservation changes the source revision', async () => {
    const store = new DutyLocalMonthSnapshots();
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [], fetchedAt: 1, expiresAt: 2 });
    jest.spyOn(store, 'preserveHistory').mockImplementation(async () => { jest.mocked(readBitableCacheScopeRevision).mockResolvedValue('new'); });
    const load = jest.fn(async (_range, persistence) => { persistence.onPersisted({ sourceStartedAt: 2, invalidationToken: 'new' }); return []; });
    await expect(synchronizeRollingSchedule({ ...source, now: new Date('2026-01-02'), store, dateOf, load, approvalReady: async () => true })).resolves.toMatchObject({ success: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares retry progress with a late caller and limits source-change retries', async () => {
    const load = jest.fn(async () => { throw Error('数据在读取期间已变更，请重新读取'); });
    const initial = jest.fn(), joined = jest.fn();
    const options = { ...source, now: new Date('2026-01-02'), store: new DutyLocalMonthSnapshots(), dateOf, load, approvalReady: async () => true };
    const first = synchronizeRollingSchedule({ ...options, phase: initial });
    const failure = expect(first).rejects.toThrow('读取期间已变更');
    for (let i = 0; i < 10 && !initial.mock.calls.some(call => call[0] === 'retrying_sources'); i++) await new Promise(resolve => setImmediate(resolve));
    const second = synchronizeRollingSchedule({ ...options, phase: joined });
    expect(second).toBe(first);
    expect(joined).toHaveBeenCalledWith('retrying_sources');
    await failure;
    expect(load).toHaveBeenCalledTimes(3);
    expect(joined.mock.calls.filter(call => call[0] === 'fetching_sources')).toHaveLength(2);
  }, 10_000);

  it('does not replace the prior month when a dependency changes before commit', async () => {
    const store = new DutyLocalMonthSnapshots();
    const range = { startDate: '2025-12-01', endDate: '2026-02-28', months: ['2025-12','2026-01','2026-02'] };
    await store.publish(source.appToken, source.tableId, range, [row('old', '2026-01-02')], 1, null, dateOf);
    let checks = 0;
    await expect(store.publish(source.appToken, source.tableId, range, [row('new', '2026-01-02')], 2, null, dateOf, async () => {
      if (++checks === 2) throw Error('dependency changed');
    })).rejects.toThrow('dependency changed');
    expect((await store.readMonth(source.appToken, source.tableId, '2026-01'))?.records).toEqual([row('old', '2026-01-02')]);
    expect(checks).toBe(2);
  });

  it('keeps history across restart and invalidation without authorizing from historical fallback', async () => {
    const full = { records: [row('history', '2025-08-10')], fetchedAt: 1, expiresAt: 2, sourceStartedAt: 1 };
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(full);
    await synchronizeRollingSchedule({ ...source, now: new Date('2026-01-02'), store: new DutyLocalMonthSnapshots(), dateOf,
      load: async (_range, persistence) => { persistence.onPersisted({ sourceStartedAt: Date.now(), invalidationToken: null }); return [row('new', '2026-01-02')]; }, approvalReady: async () => true });
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    jest.mocked(readBitableCacheScopeRevision).mockResolvedValue('changed');
    const historical = await readRollingScheduleRange(source, '2025-08-01', '2025-08-31', { historical: true, now: new Date('2026-01-02') });
    expect(historical[0].snapshot.records).toEqual(full.records);
    await expect(readRollingScheduleRange(source, '2025-08-01', '2025-08-31')).rejects.toThrow('缓存');
    await expect(readRollingScheduleRange(source, '2026-01-01', '2026-01-31', { now: new Date('2026-01-02') })).rejects.toThrow('缓存');
  });

  it('does not publish an unverified replacement or delete an existing month', async () => {
    const store = new DutyLocalMonthSnapshots();
    await store.publish(source.appToken, source.tableId, { startDate: '2025-12-01', endDate: '2026-02-28', months: ['2025-12','2026-01','2026-02'] }, [row('old', '2026-01-02')], 1, null, dateOf);
    await expect(synchronizeRollingSchedule({ ...source, now: new Date('2026-01-02'), store, dateOf,
      load: async (_range, persistence) => { persistence.onPersisted({ sourceStartedAt: 2, invalidationToken: null }); return []; }, approvalReady: async () => false })).rejects.toThrow('尚未完整保存');
    expect((await store.readMonth(source.appToken, source.tableId, '2026-01'))?.records).toEqual([row('old', '2026-01-02')]);
  });

  it('keeps an expired display snapshot while strict business reads fail closed', async () => {
    const full = { records: [row('old-display', '2026-01-02')], fetchedAt: 1, expiresAt: 2 };
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(full);
    await expect(readRollingScheduleRange(source, '2026-01-01', '2026-01-31', { now: new Date('2026-01-02'), display: true })).resolves.toMatchObject([{ stale: true, snapshot: { records: full.records } }]);
    await expect(readRollingScheduleRange(source, '2026-01-01', '2026-01-31', { now: new Date('2026-01-02') })).rejects.toThrow('缓存');
  });

  it.each(['schedule', 'non-duty'] as const)('limits the scheduled %s source with a real date filter', async kind => {
    const service = Object.assign(new BitableSyncService({} as never, {} as never), { SCHEDULE_APP_TOKEN: 'synthetic', SCHEDULE_TABLE_ID: 'schedule', NON_DUTY_APP_TOKEN: 'synthetic', NON_DUTY_TABLE_ID: 'non-duty' }) as any;
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => {
      expect(options.filter?.conditions).toHaveLength(2);
      expect(options.strict).toBe(true); expect(options.allowStale).toBe(false);
      options.onPersisted?.({ sourceStartedAt: Date.now(), fetchedAt: Date.now(), invalidationToken: null }); return [];
    });
    await expect(service.refreshRollingScheduleCache(kind)).resolves.toBe(0);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });

  it('routes the four-hour automation through rolling sync rather than full-table database replacement', async () => {
    const rollingDuty = jest.fn(async () => ({ success: true })), rollingWhite = jest.fn(async () => ({ success: true }));
    const forbidden = jest.fn(() => { throw Error('full schedule fetch forbidden'); });
    const automation = new DutyScheduleAutomationService({ syncDutyScheduleToLocalFast: rollingDuty, syncFromFeishuBase: forbidden } as never,
      { syncNonDutyScheduleToLocalFast: rollingWhite, syncNonDutySchedule: forbidden, syncFromBitable: async () => ({ success: true }), syncOrganization: async () => ({ success: true }), syncFestivalImportantSchedule: async () => ({ success: true }) } as never, {} as never, {} as never);
    await expect(automation.syncAllLocalTables('auto-4h')).resolves.toMatchObject({ success: true });
    expect(rollingDuty).toHaveBeenCalledTimes(1); expect(rollingWhite).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  });

  it('re-reads and republishes the changed source after automatic rule writes', async () => {
    const service = Object.assign(new DutyScheduleService({} as never, {} as never), { scheduleAppToken: 'synthetic', scheduleTableId: 'schedule' }) as any;
    service.replaceLocalScheduleRecords = jest.fn(async () => 0);
    service.refreshProgramModifiedDutyStaffRecords = jest.fn(async () => {
      jest.mocked(readBitableCacheScopeRevision).mockResolvedValue('after-write');
      return { finalValues: new Map(), total: 0, reset: 0, ruleUpdated: 0, failed: 0, failures: [] };
    });
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => {
      expect(options.filter?.conditions).toHaveLength(2);
      options.onPersisted?.({ sourceStartedAt: Date.now(), fetchedAt: Date.now(), invalidationToken: 'after-write' }); return [];
    });
    await expect(service.refreshProgramModifiedDutyStaffFromRules({ source: 'auto-4h' })).resolves.toMatchObject({ success: true });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
    expect((await new DutyLocalMonthSnapshots().readMonth('synthetic', 'schedule', month))?.invalidationToken).toBe('after-write');
  });

  it('refreshes today leave through rolling sources and displays only local day records', async () => {
    const service = new BitableSyncService({} as never, {} as never) as any;
    service.refreshRollingScheduleCache = jest.fn(async () => 0);
    service.readRollingScheduleRecords = jest.fn(async () => []);
    service.fetchFeishuNonDutyRecords = jest.fn(() => { throw Error('full read forbidden'); });
    service.fetchFeishuScheduleRecords = jest.fn(() => { throw Error('full read forbidden'); });
    await service.getTodayLeaveStaff('2026-11-06', true);
    expect(service.refreshRollingScheduleCache.mock.calls.map(call => call[0])).toEqual(['non-duty', 'schedule']);
    expect(service.readRollingScheduleRecords).toHaveBeenCalledWith('schedule', '2026-11-06', '2026-11-06', true, true);
    expect(service.fetchFeishuNonDutyRecords).not.toHaveBeenCalled();
    expect(service.fetchFeishuScheduleRecords).not.toHaveBeenCalled();
  });
});
