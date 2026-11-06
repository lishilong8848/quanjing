jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn(),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  warmLatestPersistedBitableRecordSnapshotIndex: jest.fn(),
}));
jest.mock('../../server/common/feishu/dashboard-source-binding-cache', () => ({
  ...jest.requireActual('../../server/common/feishu/dashboard-source-binding-cache'),
  readDashboardSourceBinding: jest.fn(),
  writeDashboardSourceBinding: jest.fn(),
}));
import { readDashboardSourceBinding, writeDashboardSourceBinding } from '../../server/common/feishu/dashboard-source-binding-cache';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import {
  resolveBitableAppToken,
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';

const rows = [{ record_id: 'synthetic', fields: { 姓名: '测试人员', 班次: '长白', 岗位: '工程师', '机楼/专业': 'H楼' } }];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const service = new BitableSyncService({} as never, {} as never);
  const internals = service as any;
  internals.ORG_APP_TOKEN = 'app-configured';
  internals.ORG_TABLE_ID = 'table-configured';
  internals.TRAVEL_PERSON_PROFILE_VIEW_ID = 'view-configured';
  internals.LEAVE_PERSON_PROFILE_APP_TOKEN = '';
  internals.LEAVE_PERSON_PROFILE_WIKI_TOKEN = 'wiki-configured';
  internals.fetchFeishuPersonProfileRecords = jest.fn().mockResolvedValue(rows);
  return { service, internals };
}
beforeEach(() => {
  jest.clearAllMocks();
  (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-from-configured-wiki');
  (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue(null);
  (readDashboardSourceBinding as jest.Mock).mockImplementation(async source => source.appToken || 'app-from-configured-wiki');
  (writeDashboardSourceBinding as jest.Mock).mockResolvedValue(undefined);
  (fetchBitableRecords as jest.Mock).mockResolvedValue(rows);
});
afterEach(() => { jest.useRealTimers(); });

describe('personnel display cache recovery', () => {
  it('does not consume a previous application snapshot even when the Base is explicitly unchanged', async () => {
    const oldApp = process.env.FEISHU_APP_ID;
    const { service, internals } = setup();
    internals.LEAVE_PERSON_PROFILE_APP_TOKEN = 'same-explicit-base';
    (readDashboardSourceBinding as jest.Mock).mockImplementation(async source => source.appId === 'app-before' ? 'same-explicit-base' : null);
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records: rows, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    try {
      process.env.FEISHU_APP_ID = 'app-before';
      await expect(service.getPersonProfiles()).resolves.toMatchObject({ cache: { stale: false } });
      process.env.FEISHU_APP_ID = 'app-after';
      internals.fetchFeishuPersonProfileRecords.mockRejectedValue(new Error('new app cannot read source'));
      await expect(service.getPersonProfiles()).rejects.toThrow('人员资料加载失败');
      expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledTimes(1);
      expect(writeDashboardSourceBinding).not.toHaveBeenCalled();
    } finally {
      if (oldApp === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = oldApp;
    }
  });

  it('requires a complete fresh projection on first migration, not only successful Wiki resolution', async () => {
    const { service, internals } = setup();
    delete internals.fetchFeishuPersonProfileRecords;
    (readDashboardSourceBinding as jest.Mock).mockResolvedValue(null);
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records: rows, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await service.getPersonProfiles();
    expect(resolveBitableAppToken).toHaveBeenCalledTimes(1);
    expect(readLatestPersistedBitableRecordSnapshot).not.toHaveBeenCalled();
    expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ forceRefresh: true, strict: true, allowStale: false }));
    expect(writeDashboardSourceBinding).toHaveBeenCalledTimes(1);
  });
  it('reads a source-bound snapshot after restart without waiting for an unavailable Wiki', async () => {
    const { service, internals } = setup();
    (readDashboardSourceBinding as jest.Mock).mockResolvedValue('verified-base');
    (resolveBitableAppToken as jest.Mock).mockRejectedValue(new Error('wiki offline'));
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records: rows, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await expect(service.getPersonProfiles()).resolves.toMatchObject({ organizations: [{ supervisorText: '测试人员' }], cache: { stale: false } });
    expect(resolveBitableAppToken).not.toHaveBeenCalled();
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ appToken: 'verified-base' }));
    expect(internals.fetchFeishuPersonProfileRecords).not.toHaveBeenCalled();
  });

  it('can use the separately bound detail projection for public fields without leaking private data', async () => {
    const { service } = setup();
    (readDashboardSourceBinding as jest.Mock).mockImplementation(async source => source.fieldNames.includes('照片') ? 'detail-base' : null);
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records: [{ ...rows[0], fields: { ...rows[0].fields, 联系方式: 'PRIVATE_SENTINEL', 照片: [{ file_token: 'PRIVATE_SENTINEL' }] } }], fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const response = await service.getPersonProfiles();
    expect(resolveBitableAppToken).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('PRIVATE_SENTINEL');
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ appToken: 'detail-base', fieldNames: expect.arrayContaining(['照片']) }));
  });

  it('publishes the exact binding only after a successful fresh projected read', async () => {
    const { service, internals } = setup();
    delete internals.fetchFeishuPersonProfileRecords;
    await service.getPersonProfiles(true);
    expect(resolveBitableAppToken).toHaveBeenCalledTimes(1);
    expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ forceRefresh: true, strict: true, allowStale: false }));
    expect(writeDashboardSourceBinding).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'person-profile-display', wikiToken: 'wiki-configured', fieldNames: expect.arrayContaining(['姓名']) }), 'app-from-configured-wiki');
    expect((fetchBitableRecords as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((writeDashboardSourceBinding as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('does not publish a binding from a failed or source-changed refresh', async () => {
    const { service, internals } = setup();
    delete internals.fetchFeishuPersonProfileRecords;
    (fetchBitableRecords as jest.Mock).mockRejectedValueOnce(new Error('incomplete source'));
    await expect(service.getPersonProfiles(true)).rejects.toThrow('人员资料加载失败');
    expect(writeDashboardSourceBinding).not.toHaveBeenCalled();
    const pending = deferred<typeof rows>();
    (fetchBitableRecords as jest.Mock).mockReturnValueOnce(pending.promise);
    const refresh = service.getPersonProfiles(true);
    await tick();
    internals.LEAVE_PERSON_PROFILE_WIKI_TOKEN = 'changed-wiki';
    pending.resolve(rows);
    await expect(refresh).rejects.toThrow('人员资料加载失败');
    expect(writeDashboardSourceBinding).not.toHaveBeenCalled();
  });

  it('coalesces cold public requests and returns the recovered projection', async () => {
    const { service, internals } = setup();
    const slow = deferred<typeof rows>();
    internals.fetchFeishuPersonProfileRecords.mockReturnValue(slow.promise);
    const first = service.getPersonProfiles();
    const second = service.getPersonProfiles();
    await tick();
    expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalledTimes(1);
    slow.resolve(rows);
    for (const result of await Promise.all([first, second])) {
      expect(result.organizations[0].supervisorText).toBe('测试人员');
      expect(result.cache).toEqual({ fetchedAt: expect.any(Number), stale: false, refreshing: false });
    }
  });

  it('does not let a stalled bulk task block travel or leave display refresh', async () => {
    const { internals } = setup();
    internals.cacheRefreshRunning = true;
    await internals.refreshPersonProfileLocalCache();
    expect(internals.fetchFeishuPersonProfileRecords.mock.calls).toEqual(expect.arrayContaining([
      [true, 'leave'], [true, 'leave', true], [true, 'travel'], [true, 'travel', true],
    ]));
    expect(internals.getPersonProfileRefreshMs()).toBe(15 * 60_000);
  });

  it('releases failed projection requests so a retry can recover', async () => {
    const { service, internals } = setup();
    internals.fetchFeishuPersonProfileRecords.mockRejectedValueOnce(new Error('source failed'));
    await expect(service.getPersonProfiles()).rejects.toThrow('人员资料加载失败');
    await expect(service.getPersonProfiles()).resolves.toMatchObject({ organizations: [{ supervisorText: '测试人员' }] });
    expect(internals.personProfileRefreshes.size).toBe(0);
  });

  it('bounds one viewer to 50 seconds without cancelling the shared refresh', async () => {
    jest.useFakeTimers();
    const { service, internals } = setup();
    const slow = deferred<typeof rows>();
    internals.fetchFeishuPersonProfileRecords.mockReturnValue(slow.promise);
    const first = service.getPersonProfiles();
    const failed = expect(first).rejects.toThrow('人员资料加载失败');
    await tick();
    jest.advanceTimersByTime(50_000);
    await failed;
    expect(internals.personProfileRefreshes.size).toBe(1);
    const retry = service.getPersonProfiles();
    await tick();
    slow.resolve(rows);
    await expect(retry).resolves.toMatchObject({ cache: { stale: false } });
    expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalledTimes(1);
  });

  it('returns the prior snapshot on refresh failure and stops automatic polling retries for 30 seconds', async () => {
    const { service, internals } = setup();
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({ records: rows, fetchedAt: 100, expiresAt: 200 });
    internals.fetchFeishuPersonProfileRecords.mockRejectedValue(new Error('source offline'));
    const before = await service.getPersonProfiles();
    expect(before.cache).toEqual({ fetchedAt: 100, stale: true, refreshing: true });
    await tick();
    const after = await service.getPersonProfiles();
    expect(after.organizations).toEqual(before.organizations);
    expect(after.cache).toEqual({ fetchedAt: 100, stale: true, refreshing: false });
    expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalledTimes(1);
  });

  it('binds cached leave data to the resolved app and preserves exact travel view/projection', async () => {
    const { service } = setup();
    await service.getPersonProfiles(false, 'leave');
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ appToken: 'app-from-configured-wiki', tableName: '请休假人员资料' }));
    await service.getPersonProfiles(false, 'travel');
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ appToken: 'app-configured', tableId: 'table-configured', viewId: 'view-configured', tableName: '差旅人员资料' }));
    for (const [query] of (readLatestPersistedBitableRecordSnapshot as jest.Mock).mock.calls) expect(query.appToken).toBeTruthy();
  });

  it('refuses an unresolvable source instead of using an unbound persisted snapshot', async () => {
    const { service, internals } = setup();
    delete internals.fetchFeishuPersonProfileRecords;
    (readDashboardSourceBinding as jest.Mock).mockResolvedValue(null);
    (resolveBitableAppToken as jest.Mock).mockRejectedValue(new Error('wiki unavailable'));
    await expect(service.getPersonProfiles()).rejects.toThrow('人员资料加载失败');
    expect(readLatestPersistedBitableRecordSnapshot).not.toHaveBeenCalled();
    expect(fetchBitableRecords).not.toHaveBeenCalled();
  });

  it('warms personnel without blocking service startup and cleans its independent timer', async () => {
    jest.useFakeTimers();
    const { service, internals } = setup();
    const prior = process.env.NANTONG_HOTFIX_SMOKE_MODE;
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    internals.refreshFeishuLocalCache = jest.fn().mockResolvedValue(undefined);
    internals.fetchFeishuPersonProfileRecords.mockReturnValue(new Promise(() => {}));
    try {
      await service.onModuleInit();
      expect(internals.personProfileRefreshTimer).toBeDefined();
      expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalled();
      service.onModuleDestroy();
      expect(internals.personProfileRefreshTimer).toBeUndefined();
      expect(internals.cacheRefreshTimer).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
      else process.env.NANTONG_HOTFIX_SMOKE_MODE = prior;
      jest.clearAllTimers();
    }
  });
});
