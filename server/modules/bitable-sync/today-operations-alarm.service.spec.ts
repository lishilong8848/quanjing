jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

import type { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BitableRecordItem,
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  buildTodayOperationsAlarmSourceFilter,
  createTodayOperationsAlarmWindow,
  TodayOperationsAlarmService,
} from './today-operations-alarm.service';

const mockedFetch = jest.mocked(fetchBitableRecords);
const mockedPersistedSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedResolve = jest.mocked(resolveBitableAppToken);
const httpService = {} as HttpService;
const serviceSource = readFileSync(
  join(
    process.cwd(),
    'server/modules/bitable-sync/today-operations-alarm.service.ts',
  ),
  'utf8',
);

const ENV_KEYS = [
  'TODAY_OPERATIONS_ALARM_BITABLE_URL',
  'TODAY_OPERATIONS_ALARM_FEISHU_APP_ID',
  'TODAY_OPERATIONS_ALARM_FEISHU_APP_SECRET',
  'FEISHU_RISK_INSPECTION_APP_ID',
  'FEISHU_RISK_INSPECTION_APP_SECRET',
  'ALI_MONTHLY_REPORT_FEISHU_APP_ID',
  'ALI_MONTHLY_REPORT_FEISHU_APP_SECRET',
  'TODAY_OPERATIONS_ALARM_AI_API_KEY',
  'TODAY_OPERATIONS_ALARM_AI_BASE_URL',
  'TODAY_OPERATIONS_ALARM_AI_MODEL',
] as const;

function shanghaiTimestamp(value: string): number {
  return Date.parse(`${value}+08:00`);
}

function alarmRecord(
  recordId: string,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
): BitableRecordItem {
  return {
    record_id: recordId,
    fields: {
      告警内容: '支撑开关状态告警',
      楼栋: 'A楼',
      等级: '重要',
      产生时间: shanghaiTimestamp(occurredAt),
      受理时间: shanghaiTimestamp(occurredAt) + 60_000,
      创建时间: shanghaiTimestamp(occurredAt) + 120_000,
      受理人: '受理人甲',
      受理描述: '人员现场检查',
      处理状态: '已处理',
      恢复状态: '已恢复',
      '预期外/预期内': '预期内',
      ...overrides,
    },
  };
}

function buildRecords(): BitableRecordItem[] {
  const duplicateFields = {
    楼栋: '测试楼栋',
    等级: '5',
    '预期外/预期内': '预期外',
    处理状态: '已处理',
    恢复状态: '已恢复',
  };

  return [
    alarmRecord('at-start', '2026-07-13T00:00:00', {
      等级: '紧急',
      确认人: '确认人甲',
    }),
    alarmRecord('yesterday-unexpected', '2026-07-19T10:00:00', {
      '预期外/预期内': '预期外',
      处理状态: '处理中',
      恢复状态: '未恢复',
      受理人: '受理人乙',
    }),
    alarmRecord('yesterday-unclassified', '2026-07-19T11:00:00', {
      楼栋: 'B楼',
      等级: '次要',
      '预期外/预期内': '',
      处理状态: '未处理',
      恢复状态: '未恢复',
      确认时间: shanghaiTimestamp('2026-07-19T11:30:00'),
      受理人: '受理人丙',
    }),
    alarmRecord('duplicate-a', '2026-07-18T08:00:00', duplicateFields),
    alarmRecord('duplicate-b', '2026-07-18T08:00:00', duplicateFields),
    alarmRecord('serious', '2026-07-15T09:00:00', {
      楼栋: 'C楼',
      等级: '严重',
      确认人: '',
      受理人: '',
    }),
    alarmRecord('before-start', '2026-07-12T23:59:59', {
      楼栋: 'D楼',
    }),
    alarmRecord('at-end', '2026-07-20T00:00:00', {
      楼栋: 'E楼',
    }),
  ];
}

describe('TodayOperationsAlarmService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T04:00:00.000Z'));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.FEISHU_RISK_INSPECTION_APP_ID = 'risk-app-id';
    process.env.FEISHU_RISK_INSPECTION_APP_SECRET = 'risk-app-secret';
    mockedResolve.mockImplementation(async (_httpService, options) =>
      options.appToken ? options.appToken : 'resolved-alarm-app-token',
    );
    mockedFetch.mockResolvedValue(buildRecords());
    mockedPersistedSnapshot.mockResolvedValue(null);
  });

  it('filters one Shanghai natural day, deduplicates record IDs not categories or content', async () => {
    const atStart = alarmRecord('same-id', '2026-07-19T00:00:00', { 受理描述: '', 确认描述: '' });
    mockedFetch.mockResolvedValue([
      atStart, atStart,
      alarmRecord('another-id', '2026-07-19T23:59:59', { 受理描述: '', 确认描述: '' }),
      alarmRecord('before', '2026-07-18T23:59:59', { 受理描述: '' }),
      alarmRecord('after', '2026-07-20T00:00:00', { 受理描述: '' }),
    ]);
    const result = await new TodayOperationsAlarmService(httpService).getDashboard(
      Object.assign({ metric: 'tagAnomaly', pageSize: '1' }, { date: '2026-07-19' }),
    );
    expect(result.window).toMatchObject({ startDate: '2026-07-19', endDateExclusive: '2026-07-20' });
    expect(result.summary.tagAnomalyTotal).toBe(2);
    expect(result.page.total).toBe(2);
    expect(result.page.totalPages).toBe(2);
    expect(result.page.items[0].id).toBe('another-id');
  });

  it.each(['2026-02-30', 'invalid', '2026-07-20', '2026-07-21'])('rejects invalid or unfinished single day %s before external reads', async (date) => {
    const service = new TodayOperationsAlarmService(httpService);
    await expect(service.getDashboard(Object.assign({}, { date }))).rejects.toMatchObject({ status: 400 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('keeps an explicit runtime HttpService injection token for Nest', () => {
    expect(serviceSource).toContain(
      "import { HttpService } from '@nestjs/axios'",
    );
    expect(serviceSource).toContain('@Inject(HttpService)');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the seven complete Shanghai calendar-day window and requests only projected alarm fields', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    const result = await service.getDashboard({});

    expect(result.window).toEqual({
      timeZone: 'Asia/Shanghai',
      startDate: '2026-07-13',
      endDateExclusive: '2026-07-20',
      yesterdayDate: '2026-07-19',
    });
    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: '',
      wikiToken: 'SOwsw315aiBJjgkl48ccoxIPntc',
      tableName: '今日全景告警信息',
      auth: {
        appId: 'risk-app-id',
        appSecret: 'risk-app-secret',
      },
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        appToken: 'resolved-alarm-app-token',
        tableId: 'tblD7hi70s6U6rlU',
        tableName: '今日全景告警信息',
        cacheTtlMs: 300_000,
        forceRefresh: false,
        strict: true,
        fieldNames: expect.arrayContaining([
          '告警内容',
          '监控对象',
          '楼栋',
          '等级',
          '产生时间',
          '预期外/预期内',
          '人工复核结果', '复核回复', '复核责任人',
        ]),
        filter: buildTodayOperationsAlarmSourceFilter({
          timeZone: 'Asia/Shanghai',
          startDate: '2026-07-13',
          endDateExclusive: '2026-07-20',
          yesterdayDate: '2026-07-19',
        }),
        sort: [{ field_name: '产生时间', desc: true }],
      }),
    );
  });

  it('preserves the custom reply when mapping and patching the current alarm cache', async () => {
    mockedFetch.mockResolvedValueOnce([alarmRecord('recCustom', '2026-07-19T10:00:00', {
      人工复核结果: '自定义回复', 复核回复: [{ type: 'text', text: '已核对，' }, { type: 'text', text: '待复查。\n重复重复' }], 复核责任人: [{ id: 'ou_test', name: '责任人' }],
    })]);
    const service = new TodayOperationsAlarmService(httpService);
    const initial = await service.getDashboard({});
    expect(initial.page.items[0].humanReview?.customReply).toBe('已核对，待复查。\n重复重复');
    service.patchHumanReview('recCustom', { 人工复核结果: '自定义回复', 复核回复: '已安排处理，待复核\n重复重复', 复核责任人: [{ id: 'ou_test', name: '责任人' }] });
    const updated = await service.getDashboard({});
    expect(updated.page.items[0].humanReview?.customReply).toBe('已安排处理，待复核\n重复重复');
    expect(updated.page.items[0].humanReview?.version).not.toBe(initial.page.items[0].humanReview?.version);
  });

  it('uses the verified Feishu datetime filter shape for the half-open window', () => {
    expect(
      buildTodayOperationsAlarmSourceFilter({
        timeZone: 'Asia/Shanghai',
        startDate: '2026-07-13',
        endDateExclusive: '2026-07-20',
        yesterdayDate: '2026-07-19',
      }),
    ).toEqual({
      conjunction: 'and',
      conditions: [
        {
          field_name: '产生时间',
          operator: 'isGreater',
          value: ['ExactDate', '1783785600000'],
        },
        {
          field_name: '产生时间',
          operator: 'isLess',
          value: ['ExactDate', '1784476800000'],
        },
      ],
    });
  });

  it('keeps the seven-day boundary correct across a year change', () => {
    expect(
      createTodayOperationsAlarmWindow(new Date('2026-01-01T15:59:59.000Z')),
    ).toEqual({
      timeZone: 'Asia/Shanghai',
      startDate: '2025-12-25',
      endDateExclusive: '2026-01-01',
      yesterdayDate: '2025-12-31',
    });
  });

  it('keeps exact half-open boundaries, duplicate ids and unclassified alarms in the summary', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    const result = await service.getDashboard({ pageSize: '20' });

    const { tagAnomalyByBuilding, ...summary } = result.summary;
    expect(summary).toEqual({
      sevenDayTotal: 6,
      expectedTotal: 2,
      unexpectedTotal: 3,
      unclassifiedTotal: 1,
      yesterdayTotal: 2,
      yesterdayExpectedTotal: 0,
      yesterdayUnexpectedTotal: 1,
      yesterdayUnclassifiedTotal: 1,
      dayBeforeYesterdayTotal: 2,
      pendingTotal: 2,
      doubleUnhandledTotal: 1,
      excludedBuildingTotal: 2,
      tagAnomalyTotal: 6,
      tagAnomalyByType: {
        missing: 5,
        format: 6,
        pending: 0,
        vague: 0,
        nonOfficial: 0,
        semantic: 0,
      },
    });
    expect(tagAnomalyByBuilding.reduce((total, point) => total + point.total, 0)).toBe(6);
    expect(result.page.total).toBe(6);
    expect(result.page.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['duplicate-a', 'duplicate-b', 'at-start']),
    );
    expect(result.page.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(['before-start', 'at-end']),
    );
  });

  it('maps source level, owner, confirmation and handling statuses without fabricating values', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    const result = await service.getDashboard({ pageSize: '20' });
    const byId = new Map(result.page.items.map((item) => [item.id, item]));

    expect(byId.get('at-start')).toMatchObject({
      level: '紧急',
      owner: '确认人甲',
      confirmationStatus: '已确认',
      processingStatus: '已处理',
      recoveryStatus: '已恢复',
      handlingStatus: '已关闭',
      expectation: 'expected',
    });
    expect(byId.get('yesterday-unexpected')).toMatchObject({
      level: '重要',
      owner: '受理人乙',
      confirmationStatus: '待确认',
      processingStatus: '处理中',
      recoveryStatus: '未恢复',
      handlingStatus: '处理中',
      expectation: 'unexpected',
    });
    expect(byId.get('yesterday-unclassified')).toMatchObject({
      level: '次要',
      owner: '受理人丙',
      confirmationStatus: '已确认',
      processingStatus: '未处理',
      recoveryStatus: '未恢复',
      handlingStatus: '未恢复',
      expectation: 'unclassified',
    });
    expect(byId.get('duplicate-a')).toMatchObject({ level: '5' });
    expect(byId.get('serious')).toMatchObject({
      level: '严重',
      owner: '—',
    });
  });

  it('returns stable A-E chart series with zeros and excludes test buildings only from charts', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    const result = await service.getDashboard({});

    expect(result.sevenDayByBuilding).toEqual([
      {
        building: 'A楼',
        expected: 1,
        unexpected: 1,
        unclassified: 0,
        total: 2,
      },
      {
        building: 'B楼',
        expected: 0,
        unexpected: 0,
        unclassified: 1,
        total: 1,
      },
      {
        building: 'C楼',
        expected: 1,
        unexpected: 0,
        unclassified: 0,
        total: 1,
      },
      {
        building: 'D楼',
        expected: 0,
        unexpected: 0,
        unclassified: 0,
        total: 0,
      },
      {
        building: 'E楼',
        expected: 0,
        unexpected: 0,
        unclassified: 0,
        total: 0,
      },
    ]);
    expect(result.yesterdayByBuilding).toEqual([
      {
        building: 'A楼',
        expected: 0,
        unexpected: 1,
        unclassified: 0,
        total: 1,
      },
      {
        building: 'B楼',
        expected: 0,
        unexpected: 0,
        unclassified: 1,
        total: 1,
      },
      {
        building: 'C楼',
        expected: 0,
        unexpected: 0,
        unclassified: 0,
        total: 0,
      },
      {
        building: 'D楼',
        expected: 0,
        unexpected: 0,
        unclassified: 0,
        total: 0,
      },
      {
        building: 'E楼',
        expected: 0,
        unexpected: 0,
        unclassified: 0,
        total: 0,
      },
    ]);
  });

  it('filters and paginates the cached seven-day snapshot without refetching Feishu', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    await service.getDashboard({});
    const filtered = await service.getDashboard({
      page: '2',
      pageSize: '1',
      building: 'A楼',
      level: '重要',
      status: '处理中',
      q: '支撑开关',
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(filtered.page).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });
    expect(filtered.page.items).toHaveLength(1);
    expect(filtered.page.items[0]?.id).toBe('yesterday-unexpected');
    expect(filtered.options.buildings).toEqual(
      expect.arrayContaining(['A楼', 'B楼', 'C楼', '测试楼栋']),
    );
    expect(filtered.options.levels).toEqual([
      '紧急',
      '严重',
      '重要',
      '次要',
      '5',
    ]);
    expect(filtered.options.statuses).toEqual(['未恢复', '处理中', '已关闭']);
    expect(filtered.options).toMatchObject({
      processingStatuses: ['未处理', '处理中', '已处理'],
      recoveryStatuses: ['未恢复', '已恢复'],
    });
  });

  it('counts anomalous records once while exposing all issue details and category filters', async () => {
    mockedFetch.mockResolvedValue([
      alarmRecord('multi-issue', '2026-07-19T09:00:00', {
        受理描述: '【设备检修】TODO',
        确认描述: '【维护】计划维护',
      }),
      alarmRecord('clean', '2026-07-19T08:00:00', {
        受理描述: '【维护】计划维护',
        确认描述: '【维护】计划维护',
      }),
      alarmRecord('self-control-fault', '2026-07-19T07:00:00', {
        受理描述: '【设备故障】人员已去现场',
        确认描述: '【设备故障】现场确认燃油自控系统故障，已联系工程师检修',
      }),
      alarmRecord('building-b-missing', '2026-07-19T06:00:00', {
        楼栋: 'B楼',
        处理状态: '处理中',
        恢复状态: '未恢复',
        受理描述: '',
        确认描述: '【设备故障】断路器无法合闸',
      }),
    ]);
    const service = new TodayOperationsAlarmService(httpService);
    const result = await service.getDashboard({ metric: 'tagAnomaly' });

    expect(result.summary.tagAnomalyTotal).toBe(2);
    expect(result.summary.tagAnomalyByType).toMatchObject({ missing: 1, format: 1, nonOfficial: 1 });
    expect(result.summary.tagAnomalyByBuilding).toEqual(expect.arrayContaining([
      expect.objectContaining({ building: 'A楼', total: 1, byType: expect.objectContaining({ format: 1, nonOfficial: 1 }) }),
      expect.objectContaining({ building: 'B楼', total: 1, byType: expect.objectContaining({ missing: 1 }) }),
    ]));
    expect(result.page.items.map((item) => item.id)).toEqual(['multi-issue', 'building-b-missing']);
    expect(result.page.items[0].tagIssues.map((issue) => issue.code)).toEqual(['format', 'nonOfficial']);
    expect(result.tagReview.state).toBe('unconfigured');

    const filtered = await service.getDashboard({ metric: 'tagAnomaly', tagIssueCode: 'nonOfficial' });
    expect(filtered.page.total).toBe(1);
    const buildingFiltered = await service.getDashboard({ metric: 'tagAnomaly', building: 'B楼', tagIssueCode: 'missing' });
    expect(buildingFiltered.page.items.map((item) => item.id)).toEqual(['building-b-missing']);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps processing, recovery, and double-unhandled filters semantically distinct', async () => {
    mockedFetch.mockResolvedValue([
      ...buildRecords(),
      alarmRecord('unhandled-recovered', '2026-07-17T12:00:00', {
        处理状态: '未处理',
        恢复状态: '已恢复',
      }),
    ]);
    const service = new TodayOperationsAlarmService(httpService);

    const dashboard = await service.getDashboard({});
    const processingOnly = await service.getDashboard({
      pageSize: '20',
      processingStatus: '未处理',
    });
    const recoveryOnly = await service.getDashboard({
      pageSize: '20',
      recoveryStatus: '未恢复',
    });
    const doubleUnhandled = await service.getDashboard({
      pageSize: '20',
      processingStatus: '未处理',
      recoveryStatus: '未恢复',
    });
    const doubleUnhandledMetric = await service.getDashboard({
      pageSize: '20',
      metric: 'doubleUnhandled',
    });

    expect(processingOnly.page.items.map((item) => item.id).sort()).toEqual([
      'unhandled-recovered',
      'yesterday-unclassified',
    ]);
    expect(recoveryOnly.page.items.map((item) => item.id)).not.toContain(
      'unhandled-recovered',
    );
    expect(doubleUnhandled.page.items.map((item) => item.id)).toEqual([
      'yesterday-unclassified',
    ]);
    expect(doubleUnhandledMetric.page.items.map((item) => item.id)).toEqual([
      'yesterday-unclassified',
    ]);
    expect(dashboard.summary.doubleUnhandledTotal).toBe(
      doubleUnhandledMetric.page.total,
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('maps alarm KPI metrics to cached detail lists without refetching Feishu', async () => {
    const service = new TodayOperationsAlarmService(httpService);

    await service.getDashboard({});
    const expected = await service.getDashboard({
      metric: 'expected',
      pageSize: '20',
    });
    const unexpected = await service.getDashboard({
      metric: 'unexpected',
      pageSize: '20',
    });
    const yesterday = await service.getDashboard({
      metric: 'yesterday',
      pageSize: '20',
    });
    const pending = await service.getDashboard({
      metric: 'pending',
      pageSize: '20',
    });
    const doubleUnhandled = await service.getDashboard({
      metric: 'doubleUnhandled',
      pageSize: '20',
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(expected.page.total).toBe(2);
    expect(
      expected.page.items.every((item) => item.expectation === 'expected'),
    ).toBe(true);
    expect(unexpected.page.total).toBe(3);
    expect(
      unexpected.page.items.every((item) => item.expectation === 'unexpected'),
    ).toBe(true);
    expect(yesterday.page.total).toBe(2);
    expect(yesterday.page.items.map((item) => item.id).sort()).toEqual([
      'yesterday-unclassified',
      'yesterday-unexpected',
    ]);
    expect(pending.page.total).toBe(2);
    expect(
      pending.page.items.every((item) => item.handlingStatus !== '已关闭'),
    ).toBe(true);
    expect(doubleUnhandled.page.total).toBe(1);
    expect(doubleUnhandled.page.items.map((item) => item.id)).toEqual([
      'yesterday-unclassified',
    ]);
  });

  it('filters every chart drilldown by period, expectation, and building without refetching Feishu', async () => {
    mockedFetch.mockResolvedValue([
      alarmRecord('a-prior-expected', '2026-07-17T09:00:00'),
      alarmRecord('a-prior-unexpected', '2026-07-17T10:00:00', {
        '预期外/预期内': '预期外',
      }),
      alarmRecord('a-prior-unclassified', '2026-07-17T11:00:00', {
        '预期外/预期内': '',
      }),
      alarmRecord('a-yesterday-expected', '2026-07-19T09:00:00'),
      alarmRecord('a-yesterday-unexpected', '2026-07-19T10:00:00', {
        '预期外/预期内': '预期外',
      }),
      alarmRecord('a-yesterday-unclassified', '2026-07-19T11:00:00', {
        '预期外/预期内': '',
      }),
      alarmRecord('b-yesterday-expected', '2026-07-19T12:00:00', {
        楼栋: 'B楼',
      }),
    ]);
    const service = new TodayOperationsAlarmService(httpService);

    const cases = [
      ['expected', ['a-yesterday-expected', 'a-prior-expected']],
      ['unexpected', ['a-yesterday-unexpected', 'a-prior-unexpected']],
      ['unclassified', ['a-yesterday-unclassified', 'a-prior-unclassified']],
      ['yesterdayExpected', ['a-yesterday-expected']],
      ['yesterdayUnexpected', ['a-yesterday-unexpected']],
      ['yesterdayUnclassified', ['a-yesterday-unclassified']],
    ] as const;

    for (const [metric, expectedIds] of cases) {
      const result = await service.getDashboard({
        metric,
        building: 'A楼',
        pageSize: '20',
      });
      expect(result.page.items.map((item) => item.id)).toEqual(expectedIds);
    }
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('uses the source URL and credentials override without changing the default route data source', async () => {
    process.env.TODAY_OPERATIONS_ALARM_BITABLE_URL =
      'https://vnet.feishu.cn/base/appOverride?table=tblOverride&view=vewOverride';
    process.env.TODAY_OPERATIONS_ALARM_FEISHU_APP_ID = 'alarm-app-id';
    process.env.TODAY_OPERATIONS_ALARM_FEISHU_APP_SECRET = 'alarm-app-secret';
    const service = new TodayOperationsAlarmService(httpService);

    await service.getDashboard({ refresh: 'true' });

    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: 'appOverride',
      wikiToken: '',
      tableName: '今日全景告警信息',
      auth: {
        appId: 'alarm-app-id',
        appSecret: 'alarm-app-secret',
      },
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        appToken: 'appOverride',
        tableId: 'tblOverride',
        viewId: 'vewOverride',
        forceRefresh: true,
      }),
    );
  });

  it('reuses the existing monthly-report Feishu credentials when dedicated credentials are absent', async () => {
    delete process.env.FEISHU_RISK_INSPECTION_APP_ID;
    delete process.env.FEISHU_RISK_INSPECTION_APP_SECRET;
    process.env.ALI_MONTHLY_REPORT_FEISHU_APP_ID = 'monthly-app-id';
    process.env.ALI_MONTHLY_REPORT_FEISHU_APP_SECRET = 'monthly-app-secret';
    const service = new TodayOperationsAlarmService(httpService);

    await service.getDashboard({});

    expect(mockedResolve).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        auth: {
          appId: 'monthly-app-id',
          appSecret: 'monthly-app-secret',
        },
      }),
    );
  });

  it('returns the last good snapshot as stale when a refresh fails', async () => {
    const service = new TodayOperationsAlarmService(httpService);
    const fresh = await service.getDashboard({});
    mockedFetch.mockRejectedValueOnce(
      new Error('tenant_access_token=must-not-be-exposed'),
    );

    const stale = await service.getDashboard({ refresh: '1' });

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.summary).toEqual(fresh.summary);
    expect(stale.warnings).toEqual([
      '飞书实时告警数据暂时不可用，当前展示最近一次成功同步的数据。',
    ]);
    expect(JSON.stringify(stale)).not.toContain('must-not-be-exposed');
  });

  it('uses only a matching persisted window snapshot as stale fallback', async () => {
    const fetchedAt = Date.parse('2026-07-20T03:55:00.000Z');
    mockedFetch.mockRejectedValueOnce(new Error('source unavailable'));
    mockedPersistedSnapshot.mockResolvedValueOnce({
      records: buildRecords(),
      fetchedAt,
      expiresAt: fetchedAt + 300_000,
    });
    const service = new TodayOperationsAlarmService(httpService);

    const stale = await service.getDashboard({});

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.syncedAt).toBe('2026-07-20T03:55:00.000Z');
    expect(stale.summary.sevenDayTotal).toBe(6);
    expect(mockedPersistedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'tblD7hi70s6U6rlU',
        tableName: '今日全景告警信息',
        filter: buildTodayOperationsAlarmSourceFilter(stale.window),
        sort: [{ field_name: '产生时间', desc: true }],
      }),
    );
  });

  it('does not reuse a snapshot from an older Shanghai calendar window', async () => {
    const service = new TodayOperationsAlarmService(httpService);
    await service.getDashboard({});
    jest.setSystemTime(new Date('2026-07-21T04:00:00.000Z'));
    mockedFetch.mockRejectedValueOnce(new Error('source unavailable'));

    await expect(service.getDashboard({})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 503 on the first source failure instead of returning fabricated alarms', async () => {
    mockedResolve.mockRejectedValueOnce(new Error('source unavailable'));
    const service = new TodayOperationsAlarmService(httpService);

    await expect(service.getDashboard({})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
