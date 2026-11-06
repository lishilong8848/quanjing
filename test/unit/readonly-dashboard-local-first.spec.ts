jest.mock('../../server/common/feishu/dashboard-source-binding-cache', () => ({ ...jest.requireActual('../../server/common/feishu/dashboard-source-binding-cache'), readDashboardSourceBinding: jest.fn().mockResolvedValue(null), writeDashboardSourceBinding: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  readLatestPersistedBitableRecords: jest.fn().mockResolvedValue(null),
}));
import { fetchBitableRecords, resolveBitableAppToken, readLatestPersistedBitableRecordSnapshot, invalidateBitableRecordCache } from '../../server/common/feishu/bitable-direct-read';
import { CertificateDashboardService } from '../../server/modules/bitable-sync/certificate-dashboard.service';
import { EquipmentLifecycleService } from '../../server/modules/equipment-lifecycle/equipment-lifecycle.service';
import { readDashboardSourceBinding, writeDashboardSourceBinding } from '../../server/common/feishu/dashboard-source-binding-cache';

const certificate = { record_id: 'person', fields: { 姓名: '测试人员', 楼栋: 'A楼', 证书是否合规: '合规' } };
const equipment = { record_id: 'asset', fields: { 设备名称: 'UPS', 楼栋: 'A楼', 状态: '在保', 本次到期日期: '2027-01-01', 合同当前状态: '在保' } };
const fetchedAt = 1700000000000;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('read-only dashboard local-first contract', () => {
  const originalApp = process.env.FEISHU_CERTIFICATE_APP_TOKEN;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(readDashboardSourceBinding).mockImplementation(async source => source.appToken || null);
    jest.mocked(writeDashboardSourceBinding).mockResolvedValue(undefined);
    process.env.FEISHU_CERTIFICATE_APP_TOKEN = 'synthetic-certificate-base';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('WMcQbPn71aXwoGsNv0vcnzz2n6c');
  });
  afterAll(() => {
    if (originalApp === undefined) delete process.env.FEISHU_CERTIFICATE_APP_TOKEN;
    else process.env.FEISHU_CERTIFICATE_APP_TOKEN = originalApp;
  });

  it('shows exact-source certificate disk data before a slow remote refresh and keeps the source timestamp', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [certificate], fetchedAt, expiresAt: fetchedAt + 1 });
    let release!: (value: typeof certificate[]) => void;
    jest.mocked(fetchBitableRecords).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const service = new CertificateDashboardService({} as never);
    let settled = false;
    const operation = service.getDashboard().then(value => { settled = true; return value; });
    await tick(); await tick();
    const returnedBeforeRemote = settled;
    release?.([certificate]);
    const result = await operation;
    expect(returnedBeforeRemote).toBe(true);
    expect(result.syncedAt).toBe(new Date(fetchedAt).toISOString());
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ appToken: 'synthetic-certificate-base', directOnly: true }));
  });

  it('shows all exact-source equipment snapshots before slow reads without manufacturing a new sync timestamp', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [equipment], fetchedAt, expiresAt: fetchedAt + 1 });
    const releases: Array<(value: typeof equipment[]) => void> = [];
    jest.mocked(fetchBitableRecords).mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const service = new EquipmentLifecycleService({} as never);
    let settled = false;
    const operation = service.getDashboard().then(value => { settled = true; return value; });
    await tick(); await tick();
    const returnedBeforeRemote = settled;
    releases.forEach(release => release([equipment]));
    const result = await operation;
    expect(returnedBeforeRemote).toBe(true);
    expect(result.syncedAt).toBe(new Date(fetchedAt).toISOString());
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledTimes(4);
    for (const [query] of jest.mocked(readLatestPersistedBitableRecordSnapshot).mock.calls) {
      expect(query).toMatchObject({ appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c', directOnly: true });
    }
  });

  it.each(['certificate', 'equipment'] as const)('%s force reads join the background read and await its real result', async kind => {
    const record = kind === 'certificate' ? certificate : equipment;
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [record], fetchedAt, expiresAt: fetchedAt + 1 });
    const releases: Array<(value: typeof record[]) => void> = [];
    jest.mocked(fetchBitableRecords).mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const service = kind === 'certificate' ? new CertificateDashboardService({} as never) : new EquipmentLifecycleService({} as never);
    await service.getDashboard();
    let settled = false;
    const forced = service.getDashboard(true).then(value => { settled = true; return value; });
    await tick(); await tick();
    expect(settled).toBe(false);
    expect(releases).toHaveLength(kind === 'certificate' ? 1 : 4);
    releases.forEach(release => release([record]));
    expect((await forced).sourceStatus).toBe('fresh');
  });

  it('retains stale certificate data after background failure without pretending it was refreshed', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [certificate], fetchedAt, expiresAt: fetchedAt + 1 });
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('secret source failure'));
    const service = new CertificateDashboardService({} as never);
    const initial = await service.getDashboard();
    await tick();
    const retained = await service.getDashboard();
    expect(retained.people).toEqual(initial.people);
    expect(retained.syncedAt).toBe(new Date(fetchedAt).toISOString());
    expect(retained.sourceStatus).toBe('stale');
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(retained)).not.toContain('secret');
  });

  it('does not use a table-only snapshot when neither an explicit Base nor an exact Wiki binding exists', async () => {
    delete process.env.FEISHU_CERTIFICATE_APP_TOKEN;
    jest.mocked(resolveBitableAppToken).mockRejectedValue(new Error('Wiki unavailable'));
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [certificate], fetchedAt, expiresAt: fetchedAt + 1 });
    const service = new CertificateDashboardService({} as never);
    await expect(service.getDashboard()).rejects.toThrow('园区持证数据同步失败');
    expect(readLatestPersistedBitableRecordSnapshot).not.toHaveBeenCalled();
  });

  it('does not reuse an unbound raw snapshot even with an explicit Base after app identity changes', async () => {
    jest.mocked(readDashboardSourceBinding).mockResolvedValue(null);
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [certificate], fetchedAt, expiresAt: fetchedAt + 1 });
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('new app has no source access'));
    await expect(new CertificateDashboardService({} as never).getDashboard()).rejects.toThrow('园区持证数据同步失败');
    expect(readLatestPersistedBitableRecordSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a late result from the previous configured source and preserves the new-source snapshot', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    let release!: (value: typeof certificate[]) => void;
    jest.mocked(fetchBitableRecords).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const service = new CertificateDashboardService({} as never);
    const old = service.getDashboard(true);
    const oldResult = old.then(() => 'unexpected-success', error => error.message);
    await tick(); await tick();
    process.env.FEISHU_CERTIFICATE_APP_TOKEN = 'different-base';
    const newer = { ...certificate, record_id: 'new-person', fields: { ...certificate.fields, 姓名: '新来源人员' } };
    jest.mocked(fetchBitableRecords).mockResolvedValue([newer]);
    await service.getDashboard(true);
    release([certificate]);
    expect(await oldResult).toContain('数据源已变化');
    expect((await service.getDashboard()).people[0].name).toBe('新来源人员');
  });

  it('keeps complete-source quality checks for empty local and remote data', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({ records: [], fetchedAt, expiresAt: fetchedAt + 1 });
    jest.mocked(fetchBitableRecords).mockResolvedValue([]);
    await expect(new CertificateDashboardService({} as never).getDashboard()).rejects.toThrow('园区持证数据同步失败');
    await expect(new EquipmentLifecycleService({} as never).getDashboard()).rejects.toThrow('设备生命周期数据暂时不可用');
  });

  it.each(['certificate', 'equipment'] as const)('drops %s derived memory immediately when the shared source is invalidated', async kind => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    const record = kind === 'certificate' ? certificate : equipment;
    jest.mocked(fetchBitableRecords).mockResolvedValue([record]);
    const service = kind === 'certificate' ? new CertificateDashboardService({} as never) : new EquipmentLifecycleService({} as never);
    await service.getDashboard(true);
    jest.mocked(fetchBitableRecords).mockClear();
    jest.mocked(fetchBitableRecords).mockResolvedValue([{ ...record, record_id: 'after-write' }]);
    // Memory-only invalidation suffices to prove the domain revision check;
    // persisted invalidation is covered by the shared helper's isolated tests.
    invalidateBitableRecordCache({ appToken: kind === 'certificate' ? 'synthetic-certificate-base' : 'WMcQbPn71aXwoGsNv0vcnzz2n6c', tableId: kind === 'certificate' ? 'tbl9NBxImAt3kzx2' : 'tblGFIJl9QQokCm0' });
    const result = await service.getDashboard();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect('people' in result ? result.people[0].id : result.assets[0].id).toBe('after-write');
  });

  it('rejects an old domain refresh after same-source invalidation even when a mock transport returns successfully', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    let release!: (value: typeof certificate[]) => void;
    jest.mocked(fetchBitableRecords).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const service = new CertificateDashboardService({} as never);
    const pending = service.getDashboard(true);
    const outcome = pending.then(() => 'unexpected-success', error => error.message);
    await tick(); await tick();
    invalidateBitableRecordCache({ appToken: 'synthetic-certificate-base', tableId: 'tbl9NBxImAt3kzx2' });
    jest.mocked(fetchBitableRecords).mockResolvedValue([{ ...certificate, record_id: 'newer' }]);
    await service.getDashboard(true);
    release([certificate]);
    expect(await outcome).toContain('数据源已变化');
    expect((await service.getDashboard()).people[0].id).toBe('newer');
  });

  it('rejects a mixed equipment aggregate if an already-completed table was invalidated while another remained pending', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
    let release!: (value: typeof equipment[]) => void;
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => {
      if (options.tableId === 'tblOnpjrcp5xR6gn') return new Promise(resolve => { release = resolve; });
      return [equipment];
    });
    const service = new EquipmentLifecycleService({} as never);
    const operation = service.getDashboard(true);
    const outcome = operation.then(() => 'unexpected-success', error => error.message);
    await tick(); await tick();
    expect(release).toBeDefined();
    // The equipment table has completed and its binding has been saved.
    expect(writeDashboardSourceBinding).toHaveBeenCalledWith(expect.objectContaining({ tableId: 'tblGFIJl9QQokCm0' }), expect.any(String));
    invalidateBitableRecordCache({ appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c', tableId: 'tblGFIJl9QQokCm0' });
    release([equipment]);
    expect(await outcome).toContain('数据源已变化');
  });
});
