jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn(),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecords: jest.fn(),
}));

import { ServiceUnavailableException } from '@nestjs/common';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import { CertificateDashboardService } from './certificate-dashboard.service';

const ENV_KEYS = [
  'FEISHU_CERTIFICATE_APP_TOKEN',
  'FEISHU_CERTIFICATE_WIKI_TOKEN',
  'FEISHU_CERTIFICATE_TABLE_ID',
] as const;

const sourceRecord = {
  record_id: 'rec-1',
  fields: {
    姓名: '示例人员008',
    楼栋: 'A楼',
    岗位: '运维值班员',
    班组: 'A班',
    证书是否合规: '合规',
    高压证是否有效: '✔️',
    更新时间: '2026-07-17T03:00:56.000Z',
  },
};

function buildSourceRecords(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    ...sourceRecord,
    record_id: `rec-${prefix}-${index + 1}`,
    fields: {
      ...sourceRecord.fields,
      姓名: `${prefix}${index + 1}`,
    },
  }));
}

describe('CertificateDashboardService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEISHU_CERTIFICATE_APP_TOKEN;
    delete process.env.FEISHU_CERTIFICATE_WIKI_TOKEN;
    delete process.env.FEISHU_CERTIFICATE_TABLE_ID;
    jest
      .mocked(resolveBitableAppToken)
      .mockResolvedValue('resolved-certificate-app-token');
    jest.mocked(fetchBitableRecords).mockResolvedValue([sourceRecord]);
    jest.mocked(readLatestPersistedBitableRecords).mockResolvedValue(null);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads the formal table through the Wiki token and reuses the last good snapshot', async () => {
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    const first = await service.getDashboard(false);
    const second = await service.getDashboard(false);

    expect(resolveBitableAppToken).toHaveBeenCalledWith(expect.anything(), {
      wikiToken: 'Rz4GwoB8Fi4WyokVcCPcmWJMnle',
      tableName: '园区持证正式表',
    });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'resolved-certificate-app-token',
        tableId: 'tblce45d88e70ea3',
        tableName: '园区持证正式表',
        forceRefresh: true,
        strict: true,
        validateRecords: expect.any(Function),
      }),
    );
    expect(first).toBe(second);
    expect(first.sourceStatus).toBe('fresh');
    expect(first.people).toHaveLength(1);
  });

  it('uses env overrides and force refreshes the source', async () => {
    process.env.FEISHU_CERTIFICATE_WIKI_TOKEN = 'wiki-override';
    process.env.FEISHU_CERTIFICATE_TABLE_ID = 'tblOverride';
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    await service.getDashboard(true);

    expect(resolveBitableAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ wikiToken: 'wiki-override' }),
    );
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblOverride',
        forceRefresh: true,
      }),
    );
  });

  it('uses a configured app token without resolving the Wiki node', async () => {
    process.env.FEISHU_CERTIFICATE_APP_TOKEN = 'app-override';
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    await service.getDashboard(true);

    expect(resolveBitableAppToken).not.toHaveBeenCalled();
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app-override',
        strict: true,
      }),
    );
  });

  it('returns an explicitly stale last-good snapshot when a forced refresh fails', async () => {
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);
    const fresh = await service.getDashboard(true);
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValueOnce(new Error('token=must-not-be-exposed'));

    const stale = await service.getDashboard(true);

    expect(stale.people).toEqual(fresh.people);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe('源数据同步失败，已展示上次成功结果');
    expect(JSON.stringify(stale)).not.toContain('must-not-be-exposed');
  });

  it('returns a persisted fallback as stale when the initial strict refresh fails', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValueOnce(new Error('live source unavailable'))
      .mockResolvedValueOnce([sourceRecord]);
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    const stale = await service.getDashboard(false);

    expect(fetchBitableRecords).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(fetchBitableRecords).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        forceRefresh: false,
        strict: false,
      }),
    );
    expect(stale.people).toHaveLength(1);
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe('源数据同步失败，已展示上次成功结果');
  });

  it('loads the exact persisted table snapshot as stale when Wiki resolution fails during cold start', async () => {
    jest
      .mocked(resolveBitableAppToken)
      .mockRejectedValueOnce(new Error('wiki unavailable'));
    jest
      .mocked(readLatestPersistedBitableRecords)
      .mockResolvedValueOnce([sourceRecord]);
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    const stale = await service.getDashboard(false);

    expect(fetchBitableRecords).not.toHaveBeenCalled();
    expect(readLatestPersistedBitableRecords).toHaveBeenCalledWith({
      tableId: 'tblce45d88e70ea3',
      tableName: '园区持证正式表',
    });
    expect(stale.people).toHaveLength(1);
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe('源数据同步失败，已展示上次成功结果');
  });

  it('uses a preloaded persisted count to reject a truncated cold-start refresh and reuses that snapshot as stale', async () => {
    const persistedRecords = buildSourceRecords(10, '持久人员');
    const truncatedLiveRecords = buildSourceRecords(5, '实时人员');
    jest
      .mocked(readLatestPersistedBitableRecords)
      .mockResolvedValueOnce(persistedRecords);
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(truncatedLiveRecords);
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    const result = await service.getDashboard(false);

    expect(readLatestPersistedBitableRecords).toHaveBeenCalledTimes(1);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(result.people).toHaveLength(10);
    expect(result.people[0]?.name).toBe('持久人员1');
    expect(result.sourceStatus).toBe('stale');
  });

  it('allows a small cold-start decrease relative to the preloaded persisted count', async () => {
    jest
      .mocked(readLatestPersistedBitableRecords)
      .mockResolvedValueOnce(buildSourceRecords(10, '持久人员'));
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(buildSourceRecords(8, '实时人员'));
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    const result = await service.getDashboard(false);

    expect(readLatestPersistedBitableRecords).toHaveBeenCalledTimes(1);
    expect(result.people).toHaveLength(8);
    expect(result.people[0]?.name).toBe('实时人员1');
    expect(result.sourceStatus).toBe('fresh');
  });

  it('rejects an empty or mostly unknown refresh without replacing the last good snapshot', async () => {
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);
    const fresh = await service.getDashboard(true);
    jest.mocked(fetchBitableRecords).mockResolvedValueOnce([
      {
        record_id: 'rec-known',
        fields: { 姓名: '已知人员', 证书是否合规: '合规' },
      },
      {
        record_id: 'rec-unknown-1',
        fields: { 姓名: '未知人员一', 证书是否合规: 'optUnknown' },
      },
      {
        record_id: 'rec-unknown-2',
        fields: { 姓名: '未知人员二', 证书是否合规: '异常值' },
      },
    ]);

    const stale = await service.getDashboard(true);

    expect(stale.people).toEqual(fresh.people);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.sourceStatus).toBe('stale');

    jest.mocked(fetchBitableRecords).mockResolvedValueOnce([]);
    const stillStale = await service.getDashboard(true);
    expect(stillStale.people).toEqual(fresh.people);
    expect(stillStale.syncedAt).toBe(fresh.syncedAt);
    expect(stillStale.sourceStatus).toBe('stale');
  });

  it('rejects an obvious record-count truncation but accepts a small normal decrease', async () => {
    const baselineRecords = buildSourceRecords(10, '基线人员');
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);
    jest.mocked(fetchBitableRecords).mockResolvedValueOnce(baselineRecords);
    const baseline = await service.getDashboard(true);

    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(baselineRecords.slice(0, 5));
    const truncated = await service.getDashboard(true);
    expect(truncated.people).toEqual(baseline.people);
    expect(truncated.syncedAt).toBe(baseline.syncedAt);
    expect(truncated.sourceStatus).toBe('stale');

    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(baselineRecords.slice(0, 8));
    const normalDecrease = await service.getDashboard(true);
    expect(normalDecrease.people).toHaveLength(8);
    expect(normalDecrease.sourceStatus).toBe('fresh');
  });

  it('throws instead of fabricating data when no successful snapshot exists', async () => {
    jest
      .mocked(resolveBitableAppToken)
      .mockRejectedValueOnce(new Error('source unavailable'));
    const service = new CertificateDashboardService({
      axiosRef: {},
    } as never);

    await expect(service.getDashboard(true)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
