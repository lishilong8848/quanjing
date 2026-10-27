import type { HttpService } from '@nestjs/axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  fetchBitableRecords,
  getTenantAccessToken,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { RiskInspectionService } from './risk-inspection.service';
import { QualityFollowUpTaskStore } from './quality-follow-up-task.store';

jest.mock('../../common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../common/feishu/bitable-direct-read',
  ) as object;
  return {
    ...actual,
    fetchBitableRecords: jest.fn(),
    getTenantAccessToken: jest.fn(),
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
    resolveBitableAppToken: jest.fn(),
  };
});

const mockedFetch = jest.mocked(fetchBitableRecords);
const mockedGetTenantAccessToken = jest.mocked(getTenantAccessToken);
const mockedReadSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedResolve = jest.mocked(resolveBitableAppToken);
const httpService = {} as HttpService;

function riskRecord(recordId: string): BitableRecordItem {
  return {
    record_id: recordId,
    fields: {
      发现时间: '2026-07-01',
      风险等级: '低',
      风险状态: '整改中',
      专业: '消防专业',
      '风险&问题内容描述': '测试风险',
      截止日期: '2026-07-30',
    },
  };
}

function crossRecord(recordId: string): BitableRecordItem {
  return {
    record_id: recordId,
    fields: {
      月份: '6',
      楼栋: '南通A楼',
      类型: '其他',
      检查范围: '消防安全',
      问题: '测试交叉互查问题',
      整改情况: '',
      当月问题数量: [1],
      当月问题整改完成数量: [0],
      整改率: [0],
    },
  };
}

function monthlyQualityRecord(recordId: string): BitableRecordItem {
  return {
    record_id: recordId,
    fields: {
      月份: '7月',
      检查项目: '值班纪律',
      楼栋: 'A楼',
      问题: '夜班人员瞌睡',
      问题补充描述: '已完成提醒谈话',
    },
  };
}

function monthlyQualityRatingRecord(recordId: string): BitableRecordItem {
  return {
    record_id: recordId,
    fields: {
      年份: '2026年',
      月份: '7月',
      楼栋: 'B楼',
      评分: 'A+',
      '累计A+数量': { type: 2, value: [1] },
      是否属于近期: { type: 1, value: [{ type: 'text', text: '√' }] },
    },
  };
}

describe('RiskInspectionService', () => {
  const originalAliSource = process.env.FEISHU_RISK_INSPECTION_ALI_SOURCE_URL;
  const originalCrossSource =
    process.env.FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL;
  const originalRiskAppId = process.env.FEISHU_RISK_INSPECTION_APP_ID;
  const originalRiskAppSecret = process.env.FEISHU_RISK_INSPECTION_APP_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEISHU_RISK_INSPECTION_ALI_SOURCE_URL;
    delete process.env.FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL;
    process.env.FEISHU_RISK_INSPECTION_APP_ID = 'risk-app-id';
    process.env.FEISHU_RISK_INSPECTION_APP_SECRET = 'risk-app-secret';
    mockedResolve.mockImplementation(async (_httpService, options) =>
      options.appToken ? options.appToken : 'resolved-ali-app-token',
    );
    mockedGetTenantAccessToken.mockResolvedValue('tenant-token');
    mockedReadSnapshot.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalAliSource === undefined) {
      delete process.env.FEISHU_RISK_INSPECTION_ALI_SOURCE_URL;
    } else {
      process.env.FEISHU_RISK_INSPECTION_ALI_SOURCE_URL = originalAliSource;
    }
    if (originalCrossSource === undefined) {
      delete process.env.FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL;
    } else {
      process.env.FEISHU_RISK_INSPECTION_CROSS_SOURCE_URL = originalCrossSource;
    }
    if (originalRiskAppId === undefined) {
      delete process.env.FEISHU_RISK_INSPECTION_APP_ID;
    } else {
      process.env.FEISHU_RISK_INSPECTION_APP_ID = originalRiskAppId;
    }
    if (originalRiskAppSecret === undefined) {
      delete process.env.FEISHU_RISK_INSPECTION_APP_SECRET;
    } else {
      process.env.FEISHU_RISK_INSPECTION_APP_SECRET = originalRiskAppSecret;
    }
  });

  test('reads the Ali wiki table with the exact table and view ids', async () => {
    mockedFetch.mockResolvedValue([riskRecord('ali-1')]);
    const service = new RiskInspectionService(httpService);

    const result = await service.getAliDashboard({
      month: '2026-07',
      refresh: '1',
    });

    expect(result.sourceStatus).toBe('fresh');
    expect(result.summary.historyTotal).toBe(1);
    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: '',
      wikiToken: 'SOwsw315aiBJjgkl48ccoxIPntc',
      tableName: '现场风险检查-Ali',
      auth: {
        appId: 'risk-app-id',
        appSecret: 'risk-app-secret',
      },
    });
    expect(mockedFetch).toHaveBeenCalledWith(httpService, {
      appToken: 'resolved-ali-app-token',
      tableId: 'tblcTPsC1Z057ic8',
      viewId: 'vewD2Rmoz3',
      tableName: '现场风险检查-Ali',
      cacheTtlMs: 300_000,
      forceRefresh: true,
      strict: true,
      auth: {
        appId: 'risk-app-id',
        appSecret: 'risk-app-secret',
      },
    });
  });

  test('reads the monthly quality wiki view with the exact table and view ids', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblNXLt8mIDaaB2e') {
        return [monthlyQualityRatingRecord('rating-1')];
      }
      return [monthlyQualityRecord('quality-1')];
    });
    const service = new RiskInspectionService(httpService);

    const result = await service.getAliMonthlyQuality({ refresh: '1' });

    expect(result.sourceStatus).toBe('fresh');
    expect(result.issues).toHaveLength(1);
    expect(result.ratings).toHaveLength(1);
    expect(result.sources).toMatchObject({
      issues: { status: 'fresh' },
      ratings: { status: 'fresh' },
    });
    expect(
      mockedResolve.mock.calls.map(([, options]) => options.tableName),
    ).toEqual(
      expect.arrayContaining(['阿里月度质量检查清单', '阿里月度质量评级']),
    );
    expect(
      mockedFetch.mock.calls.map(([, options]) => ({
        tableId: options.tableId,
        viewId: options.viewId,
        forceRefresh: options.forceRefresh,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          tableId: 'tbl2ukkCV1Fjh149',
          viewId: 'vewPxuzNcN',
          forceRefresh: true,
        },
        {
          tableId: 'tblNXLt8mIDaaB2e',
          viewId: 'vewtVt4UKI',
          forceRefresh: true,
        },
      ]),
    );
  });

  test('writes and confirms only the supplemental field for the administrator building', async () => {
    const original = monthlyQualityRecord('recQuality1');
    const updated = {
      ...original,
      fields: { ...original.fields, 问题补充描述: '已完成二次核查' },
    };
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { code: 0, data: { record: original } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { record: updated } } });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = new RiskInspectionService({ axiosRef: { get, put } } as unknown as HttpService);

    await expect(service.updateAliMonthlyQualitySupplemental('recQuality1', {
      supplemental: '已完成二次核查',
      expectedSupplemental: '已完成提醒谈话',
      clientMutationId: 'quality-test-1',
    }, { role: 'building_admin', purchaseBuilding: 'A楼' })).resolves.toEqual({
      recordId: 'recQuality1',
      supplemental: '已完成二次核查',
      clientMutationId: 'quality-test-1',
      syncStatus: 'success',
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recQuality1'),
      { fields: { 问题补充描述: '已完成二次核查' } },
      expect.objectContaining({ headers: { Authorization: 'Bearer tenant-token' } }),
    );

    get.mockResolvedValueOnce({ data: { code: 0, data: { record: original } } });
    await expect(service.updateAliMonthlyQualitySupplemental('recQuality1', {
      supplemental: '跨楼栋修改',
      expectedSupplemental: '已完成提醒谈话',
      clientMutationId: 'quality-test-2',
    }, { role: 'building_admin', purchaseBuilding: '110站' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test('accepts a durable follow-up task and reports the confirmed result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quality-follow-up-service-'));
    const original = monthlyQualityRecord('recQualityTask1');
    const updated = { ...original, fields: { ...original.fields, 问题补充描述: '任务同步完成' } };
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { code: 0, data: { record: original } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { record: updated } } });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const store = new QualityFollowUpTaskStore(join(directory, 'ledger.json'));
    const service = new RiskInspectionService({ axiosRef: { get, put } } as unknown as HttpService, store);
    try {
      const principal = { role: 'building_admin' as const, purchaseBuilding: 'A楼' as const };
      const input = {
        supplemental: '任务同步完成', expectedSupplemental: '已完成提醒谈话',
        clientMutationId: 'quality-task-test-1',
      };
      const accepted = await service.acceptAliMonthlyQualitySupplemental('recQualityTask1', input, principal);
      expect(accepted.syncStatus).toBe('pending');
      expect(new QualityFollowUpTaskStore(join(directory, 'ledger.json')).get(accepted.taskId)).not.toBeNull();
      service.onModuleInit();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (service.getAliMonthlyQualitySupplementalTask(accepted.taskId, principal).syncStatus === 'success') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(service.getAliMonthlyQualitySupplementalTask(accepted.taskId, principal)).toMatchObject({
        syncStatus: 'success', supplemental: '任务同步完成',
      });
      expect((await service.acceptAliMonthlyQualitySupplemental('recQualityTask1', input, principal)).taskId)
        .toBe(accepted.taskId);
      expect(put).toHaveBeenCalledTimes(1);
      expect(() => service.getAliMonthlyQualitySupplementalTask(accepted.taskId, {
        role: 'building_admin', purchaseBuilding: '110站',
      })).toThrow();
    } finally {
      service.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('downloads monthly quality image evidence without exposing its file token', async () => {
    const sourceDownloadUrl =
      'https://open.feishu.cn/open-apis/drive/v1/medias/private-file-token/download?extra=%7B%22mount_node_token%22%3A%22record-field%22%7D';
    const axiosGet = jest.fn().mockResolvedValueOnce({
      data: Buffer.from('image-bytes'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const mediaHttpService = {
      axiosRef: { get: axiosGet },
    } as unknown as HttpService;
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblNXLt8mIDaaB2e') {
        return [monthlyQualityRatingRecord('rating-1')];
      }
      return [
        {
          ...monthlyQualityRecord('quality-evidence'),
          fields: {
            ...monthlyQualityRecord('quality-evidence').fields,
            问题图片: [
              {
                name: '现场证据.jpg',
                size: 11,
                type: 'image/jpeg',
                file_token: 'private-file-token',
                url: sourceDownloadUrl,
              },
            ],
          },
        },
      ];
    });
    const service = new RiskInspectionService(mediaHttpService);
    const dataset = await service.getAliMonthlyQuality({ refresh: '1' });

    expect(JSON.stringify(dataset)).not.toContain('private-file-token');
    const evidence = await service.getAliMonthlyQualityEvidence(
      'quality-evidence',
      'image',
      '0',
    );

    expect(evidence).toEqual({
      buffer: Buffer.from('image-bytes'),
      contentType: 'image/jpeg',
      fileName: '现场证据.jpg',
    });
    expect(mockedGetTenantAccessToken).toHaveBeenCalledWith(
      mediaHttpService,
      expect.objectContaining({ appId: 'risk-app-id' }),
    );
    expect(axiosGet).toHaveBeenCalledWith(
      sourceDownloadUrl,
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        responseType: 'arraybuffer',
      }),
    );
    expect(JSON.stringify(axiosGet.mock.calls)).not.toContain(
      'example.invalid',
    );
  });

  test('serves monthly alarm screenshots through the backend without exposing the file token', async () => {
    const sourceUrl =
      'https://open.feishu.cn/open-apis/drive/v1/medias/alarm-private-token/download';
    const axiosGet = jest.fn().mockResolvedValue({
      data: Buffer.from('alarm-image'),
      headers: { 'content-type': 'image/png' },
    });
    const mediaHttpService = {
      axiosRef: { get: axiosGet },
    } as unknown as HttpService;
    mockedFetch.mockResolvedValue([
      {
        record_id: 'alarm-image',
        fields: {
          序号: 'ALARM-202609-event-1',
          标题: '告警打标规范性',
          楼栋: 'D',
          备注截图: [
            {
              name: '打标.png',
              type: 'image/png',
              file_token: 'alarm-private-token',
              url: sourceUrl,
            },
          ],
        },
      },
    ]);
    const service = new RiskInspectionService(mediaHttpService);
    const overview = await service.getMonthlyAlarmOverview();
    expect(JSON.stringify(overview)).not.toContain('alarm-private-token');

    await expect(
      service.getMonthlyAlarmEvidence('alarm-image', '0'),
    ).resolves.toEqual({
      buffer: Buffer.from('alarm-image'),
      contentType: 'image/png',
      fileName: '打标.png',
    });
    expect(axiosGet).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({
        responseType: 'arraybuffer',
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
    await expect(
      service.getMonthlyAlarmEvidence('alarm-image', '-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test.each([
    ['../quality-evidence', 'image', '0'],
    ['quality-evidence', 'document', '0'],
    ['quality-evidence', 'image', '-1'],
  ])(
    'rejects invalid monthly quality evidence coordinates %#',
    async (recordId, kind, index) => {
      const service = new RiskInspectionService(httpService);

      await expect(
        service.getAliMonthlyQualityEvidence(recordId, kind, index),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  test('reads the complete cross-inspection table without applying the source view filter', async () => {
    mockedFetch.mockResolvedValue([crossRecord('cross-1')]);
    const service = new RiskInspectionService(httpService);

    const result = await service.getCrossDashboard({
      month: '6月',
      refresh: '0',
    });

    expect(result.sourceStatus).toBe('fresh');
    expect(result.selectedMonth).toBe('6月');
    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: 'E8bybwfd6a3kAKsBPmCc2WA0nch',
      wikiToken: '',
      tableName: '交叉互查互纠',
      auth: {
        appId: 'risk-app-id',
        appSecret: 'risk-app-secret',
      },
    });
    expect(mockedFetch).toHaveBeenCalledWith(httpService, {
      appToken: 'E8bybwfd6a3kAKsBPmCc2WA0nch',
      tableId: 'tblskUG3o7nbJAoJ',
      tableName: '交叉互查互纠',
      cacheTtlMs: 300_000,
      forceRefresh: false,
      strict: true,
      auth: {
        appId: 'risk-app-id',
        appSecret: 'risk-app-secret',
      },
    });
    expect(mockedFetch.mock.calls[0]?.[1]).not.toHaveProperty('viewId');
  });

  test('reads all three cross-inspection guide tables and returns a paged catalog', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblaK4n3JtsWDV3V') {
        return [
          {
            record_id: 'system-guide',
            fields: {
              风险编号: 'GL-001',
              一级分类: '管理风险',
              检查项: '核查管理制度。',
            },
          },
        ];
      }
      if (options.tableId === 'tblZkw7z0DmCnMGl') {
        return [
          {
            record_id: 'ali-guide',
            fields: {
              文本: 'ALI-001',
              专业: '弱电',
              检查项目: '核查双路供电。',
            },
          },
        ];
      }
      if (options.tableId === 'tblPqIuib8UjoNMp') {
        return [
          {
            record_id: 'environment-guide',
            fields: {
              序号: 'XCHJ-001',
              检查项: '卫生环境',
              检查细项: '核查机房卫生。',
            },
          },
        ];
      }
      return [];
    });
    const service = new RiskInspectionService(httpService);

    const result = await service.getCrossGuides({
      page: '1',
      pageSize: '20',
      source: 'all',
      query: '',
    });

    expect(result).toMatchObject({
      total: 3,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      sourceStatus: 'fresh',
    });
    expect(result.items.map(({ code }) => code)).toEqual([
      'GL-001',
      'ALI-001',
      'XCHJ-001',
    ]);
    expect(
      mockedFetch.mock.calls.map(([, options]) => options.tableId),
    ).toEqual(
      expect.arrayContaining([
        'tblaK4n3JtsWDV3V',
        'tblZkw7z0DmCnMGl',
        'tblPqIuib8UjoNMp',
      ]),
    );
    expect(
      mockedFetch.mock.calls.filter(([, options]) =>
        ['tblaK4n3JtsWDV3V', 'tblZkw7z0DmCnMGl', 'tblPqIuib8UjoNMp'].includes(
          options.tableId,
        ),
      ),
    ).toHaveLength(3);
  });

  test('serves the last successful Ali result as stale after a refresh failure', async () => {
    mockedFetch
      .mockResolvedValueOnce([riskRecord('ali-last-good')])
      .mockRejectedValueOnce(
        new Error('tenant_access_token=must-not-be-exposed'),
      );
    const service = new RiskInspectionService(httpService);

    await service.getAliDashboard({ month: '2026-07' });
    const stale = await service.getAliDashboard({
      month: '2026-07',
      refresh: '1',
    });

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.summary.historyTotal).toBe(1);
    expect(stale.warnings).toEqual([
      '飞书实时数据暂时不可用，当前展示最近一次成功同步的数据。',
    ]);
    expect(JSON.stringify(stale)).not.toContain('must-not-be-exposed');
  });

  test('serves the last successful monthly quality result as stale after a refresh failure', async () => {
    mockedFetch
      .mockResolvedValueOnce([monthlyQualityRecord('quality-last-good')])
      .mockResolvedValueOnce([monthlyQualityRatingRecord('rating-last-good')])
      .mockRejectedValueOnce(new Error('file_token=must-not-be-exposed'))
      .mockRejectedValueOnce(new Error('tenant_token=must-not-be-exposed'));
    const service = new RiskInspectionService(httpService);

    await service.getAliMonthlyQuality({});
    const stale = await service.getAliMonthlyQuality({ refresh: '1' });

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.issues).toHaveLength(1);
    expect(stale.ratings).toHaveLength(1);
    expect(stale.sources).toMatchObject({
      issues: { status: 'stale' },
      ratings: { status: 'stale' },
    });
    expect(stale.warnings).toEqual([
      '问题清单实时数据暂时不可用，当前展示最近一次成功同步的数据。',
      '评级表实时数据暂时不可用，当前展示最近一次成功同步的数据。',
    ]);
    expect(JSON.stringify(stale)).not.toContain('must-not-be-exposed');
  });

  test('keeps fresh issue records when the rating source has no usable data', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblNXLt8mIDaaB2e') {
        throw new Error('rating source unavailable');
      }
      return [monthlyQualityRecord('quality-fresh')];
    });
    const service = new RiskInspectionService(httpService);

    const result = await service.getAliMonthlyQuality({ refresh: '1' });

    expect(result.sourceStatus).toBe('stale');
    expect(result.issues).toHaveLength(1);
    expect(result.ratings).toHaveLength(0);
    expect(result.sources).toMatchObject({
      issues: { status: 'fresh' },
      ratings: { status: 'error' },
    });
    expect(result.warnings).toContain('评级表数据暂时不可用。');
  });

  test('keeps the Ali source available when cross-inspection has no usable data', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblskUG3o7nbJAoJ') {
        throw new Error('cross source unavailable');
      }
      return [riskRecord('ali-independent')];
    });
    const service = new RiskInspectionService(httpService);

    await expect(
      service.getCrossDashboard({ month: '6月' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.getAliDashboard({ month: '2026-07' }),
    ).resolves.toMatchObject({
      sourceStatus: 'fresh',
      summary: { historyTotal: 1 },
    });
  });
});
