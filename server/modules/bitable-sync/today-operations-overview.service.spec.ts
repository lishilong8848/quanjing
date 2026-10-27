jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

import type { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import { TodayOperationsOverviewService } from './today-operations-overview.service';

const mockedFetch = jest.mocked(fetchBitableRecords);
const mockedPersistedSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedResolve = jest.mocked(resolveBitableAppToken);
const httpService = {} as HttpService;

function record(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

function formulaNumber(value: number): Record<string, unknown> {
  return { type: 2, value: [value] };
}

const rackLoads = [
  ['A楼', 0.6],
  ['B楼', 0.7],
  ['C楼', 0.8],
  ['D楼', 0.5],
  ['E楼', 0.3],
].map(([building, load], index) =>
  record(`load-${index}`, {
    楼栋: building,
    日期: Date.parse('2026-07-20T00:00:00+08:00'),
    IT负载率: formulaNumber(Number(load)),
  }),
);

const rackMonthly = [
  ['A楼', 1000, 800],
  ['B楼', 900, 675],
  ['C楼', 1100, 834],
  ['D楼', 800, 401],
  ['E楼', 1200, 990],
].map(([building, total, online], index) =>
  record(`rack-${index}`, {
    楼栋名称: building,
    年度: '2026',
    月度: '07',
    当月最后日期: formulaNumber(46222),
    机柜设计数量: formulaNumber(Number(total)),
    实际上电数量: formulaNumber(Number(online)),
  }),
);

function shiftRows(
  date: string,
  shift: '白班' | '夜班',
  poweredOn: number[],
  poweredOff: number[],
): BitableRecordItem[] {
  return ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((building, index) =>
    record(`${date}-${shift}-${building}`, {
      楼栋: building,
      日期: Date.parse(`${date}T00:00:00+08:00`),
      班次: shift,
      '本班组上电机柜数（个）': poweredOn[index],
      '本班组下电机柜数（个）': poweredOff[index],
      修改时间:
        Date.parse(`${date}T08:00:00+08:00`) +
        (shift === '白班' ? 12 * 60 * 60 * 1000 : 0),
    }),
  );
}

const rackShiftRows = [
  ...shiftRows('2026-07-20', '白班', [1, 1, 0, 0, 0], [0, 1, 0, 0, 0]),
  ...shiftRows('2026-07-19', '夜班', [1, 1, 1, 1, 0], [1, 0, 0, 0, 0]),
  ...shiftRows('2026-07-14', '白班', [1, 1, 0, 0, 0], [0, 1, 0, 0, 0]),
  ...shiftRows('2026-07-13', '夜班', [1, 0, 0, 0, 0], [1, 1, 0, 0, 0]),
];

const todayEvents = [
  record('event-closed', {
    事件发生时间: Date.parse('2026-07-20T08:00:00+08:00'),
    最终状态: ['事件闭环未转检修'],
    事件编号: 'INC-001',
    事件简述: 'A楼供电事件',
    事件等级: 'I2',
    机楼: 'A楼',
    专业: '电气',
    事件目前进展: '已闭环',
  }),
  record('event-open', {
    事件发生时间: Date.parse('2026-07-20T09:00:00+08:00'),
    最终状态: ['响应跟进'],
    事件编号: 'INC-002',
    事件简述: 'B楼空调事件',
    事件等级: 'I3',
    机楼: 'B楼',
    专业: '暖通',
    事件目前进展: '响应跟进',
  }),
];

const priorOpenEvent = record('event-prior-open', {
  事件发生时间: Date.parse('2026-07-19T22:00:00+08:00'),
  最终状态: ['应急恢复'],
  事件编号: 'INC-PRIOR',
  事件简述: 'C楼跨日未完成事件',
  事件等级: 'I2',
  机楼: 'C楼',
  专业: '暖通',
  事件目前进展: '持续恢复中',
});

const allEvents = [...todayEvents, priorOpenEvent];

const todayChanges = [
  record('change-active', {
    变更开始时间: Date.parse('2026-07-20T08:00:00+08:00'),
    变更结束时间: Date.parse('2026-07-21T08:00:00+08:00'),
    变更状态: '开始',
    今日是否进行: '是',
    变更编码: 'CHG-001',
    变更简述: 'A楼配电切换---',
    '智航-变更等级': 'I3',
    '阿里-变更等级': '超低',
    楼栋: '  A楼---  ',
    专业: '电气 —-- ',
    影响: '无业务影响',
    主管: '张工',
  }),
  record('change-finished', {
    变更开始时间: Date.parse('2026-07-20T10:00:00+08:00'),
    变更结束时间: Date.parse('2026-07-20T11:00:00+08:00'),
    实际结束时间: Date.parse('2026-07-20T11:10:00+08:00'),
    变更状态: '结束',
    今日是否进行: '是',
    变更编码: 'CHG-002',
    变更简述: 'B楼网络调整',
    '智航-变更等级': 'I2',
    '阿里-变更等级': '低',
    楼栋: 'B楼',
    专业: '网络',
    主管: '李工',
  }),
  record('change-bad-end-year', {
    变更开始时间: Date.parse('2026-07-20T12:00:00+08:00'),
    变更结束时间: Date.parse('2025-07-21T12:00:00+08:00'),
    变更状态: '开始',
    今日是否进行: '否',
    变更编码: 'CHG-003',
    变更简述: 'C楼制冷优化',
    '智航-变更等级': 'I4',
    '阿里-变更等级': '中风险',
    楼栋: 'C楼',
    专业: '暖通',
    主管: '王工',
  }),
];

const activeChanges = [
  todayChanges[0],
  todayChanges[2],
  record('change-prior-active', {
    变更开始时间: Date.parse('2026-07-19T08:00:00+08:00'),
    变更结束时间: Date.parse('2026-07-21T08:00:00+08:00'),
    变更状态: '更新',
    今日是否进行: '否',
    变更编码: 'CHG-PRIOR',
    变更简述: '跨日变更',
    '智航-变更等级': 'I3',
    '阿里-变更等级': '低',
  }),
  record('change-stale', {
    变更开始时间: Date.parse('2026-06-01T08:00:00+08:00'),
    变更结束时间: Date.parse('2026-06-02T08:00:00+08:00'),
    变更状态: '开始',
    今日是否进行: '否',
    变更编码: 'CHG-STALE',
    变更简述: '历史变更',
    '智航-变更等级': 'I1',
    '阿里-变更等级': '高风险',
  }),
  record('change-future', {
    变更开始时间: Date.parse('2026-07-21T08:00:00+08:00'),
    变更结束时间: Date.parse('2026-07-21T10:00:00+08:00'),
    变更状态: '开始',
    今日是否进行: '否',
    变更编码: 'CHG-FUTURE',
    变更简述: '未来变更',
    '智航-变更等级': 'I2',
    '阿里-变更等级': '中风险',
  }),
];

const maintenanceRows = [
  record('maintenance-active', {
    今天是否进行: ['是'],
    实际状态: ['进行中'],
    维保项目名称: 'A楼冷机年度维保',
    楼栋: 'A楼',
  }),
  record('maintenance-finished', {
    今天是否进行: ['是'],
    实际状态: ['正常结束'],
    项目名称: 'B楼消防系统维保',
    机楼: 'B楼',
  }),
  record('maintenance-not-started', {
    今天是否进行: ['是'],
    实际状态: ['未开始'],
  }),
];

const inspectionRows = [
  record('inspection-active', {
    今天是否进行: ['是'],
    检修状态: '开始',
    标题: 'A楼柴油机冷却系统检修',
    检修项目名称: '不应优先的检修项目名称',
    维修方式: '计划检修',
    实际开始时间: Date.parse('2026-07-20T23:30:00+08:00'),
    预期结束时间: Date.parse('2026-07-22T00:30:00+08:00'),
    楼栋: ' A楼--- ',
    专业: '暖通—— ',
  }),
  record('inspection-finished', {
    今天是否进行: ['是'],
    检修状态: '结束',
    名称: 'B楼配电柜检修',
    检修方式: '故障维修',
    计划开始时间: Date.parse('2026-07-20T08:00:00+08:00'),
    计划结束时间: Date.parse('2026-07-20T18:00:00+08:00'),
    实际结束时间: Date.parse('2026-07-20T17:00:00+08:00'),
    机楼: 'B楼',
  }),
  record('inspection-unknown', {
    今天是否进行: ['是'],
    检修状态: '',
  }),
];

describe('TodayOperationsOverviewService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T04:00:00.000Z'));
    mockedResolve.mockImplementation(
      async (_httpService, options) =>
        options.appToken || 'resolved-notice-app',
    );
    mockedPersistedSnapshot.mockResolvedValue(null);
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'tblBgaPzuVj7V9Q6') return rackLoads;
      if (options.tableId === 'tblDYQYihJ0CgepE') return rackMonthly;
      if (options.tableId === 'tblz8rjxdtRRlYmS') return rackShiftRows;
      if (options.tableId === 'tblj9XJLq5QzTAqX') {
        return allEvents;
      }
      if (options.tableId === 'tblYodlEKeWzqogu') {
        if (!options.filter) return [...todayChanges, ...activeChanges];
        return options.filter?.conditions[0]?.field_name === '变更开始时间'
          ? todayChanges
          : activeChanges;
      }
      if (options.tableId === 'tblk7QuEsiE4p3nZ') return maintenanceRows;
      if (options.tableId === 'tblpaHktT0mn0hwg') return inspectionRows;
      throw new Error(`Unexpected source ${options.tableId}`);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('isolates a failed rack source from successful operations on a cold start', async () => {
    const original = mockedFetch.getMockImplementation()!;
    mockedFetch.mockImplementation((http, options) => {
      if (options.tableId === 'tblBgaPzuVj7V9Q6')
        return Promise.reject(new Error('offline'));
      return original(http, options);
    });
    const result = await new TodayOperationsOverviewService(
      httpService,
    ).getOverview();
    expect(result.rackSummary).toBeNull();
    expect(result.sourceStatus).toBe('partial');
    expect(result.sourceStates.events.status).toBe('fresh');
    expect(result.details.events.length).toBeGreaterThan(0);
  });

  it('reads only the two relevant weeks and rack movement fields before the deadline', async () => {
    const original = mockedFetch.getMockImplementation()!;
    mockedFetch.mockImplementation((http, options) => {
      if (options.tableId === 'tblz8rjxdtRRlYmS' && !options.filter)
        return new Promise(() => {});
      return original(http, options);
    });
    const resultPromise = new TodayOperationsOverviewService(
      httpService,
    ).getOverview();
    await jest.advanceTimersByTimeAsync(10_001);
    const result = await resultPromise;
    expect(result.rackSummary).toMatchObject({
      poweredOnThisWeek: 2,
      poweredOnWeekDelta: -5,
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblz8rjxdtRRlYmS',
        fieldNames: [
          '楼栋',
          '日期',
          '班次',
          '修改时间',
          '本班组上电机柜数（个）',
          '本班组下电机柜数（个）',
        ],
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '日期',
              operator: 'isGreater',
              value: [
                'ExactDate',
                String(Date.parse('2026-07-12T00:00:00+08:00')),
              ],
            },
            {
              field_name: '日期',
              operator: 'isLess',
              value: [
                'ExactDate',
                String(Date.parse('2026-07-21T00:00:00+08:00')),
              ],
            },
          ],
        },
      }),
    );
  });

  it.each([
    ['2026-10-02T12:00:00+08:00', '2026-09-20', '2026-10-03'],
    ['2026-01-01T12:00:00+08:00', '2025-12-21', '2026-01-02'],
  ])(
    'keeps the prior week across month and year boundaries on %s',
    async (now, start, end) => {
      jest.setSystemTime(new Date(now));
      await new TodayOperationsOverviewService(httpService).getOverview();
      const options = mockedFetch.mock.calls.find(
        ([, read]) => read.tableId === 'tblz8rjxdtRRlYmS',
      )![1];
      expect(
        options.filter?.conditions.map((condition) => condition.value),
      ).toEqual([
        ['ExactDate', String(Date.parse(`${start}T00:00:00+08:00`))],
        ['ExactDate', String(Date.parse(`${end}T00:00:00+08:00`))],
      ]);
    },
  );

  it('returns available data before the client deadline when a rack source hangs', async () => {
    const original = mockedFetch.getMockImplementation()!;
    mockedFetch.mockImplementation((http, options) => {
      if (options.tableId === 'tblBgaPzuVj7V9Q6') return new Promise(() => {});
      return original(http, options);
    });
    const resolved = jest.fn();
    void new TodayOperationsOverviewService(httpService)
      .getOverview()
      .then(resolved);
    await jest.advanceTimersByTimeAsync(10_001);
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({
        rackSummary: null,
        sourceStatus: 'partial',
      }),
    );
  });

  it('does not let slow wiki resolution block independent rack sources', async () => {
    mockedResolve.mockImplementation((_http, options) =>
      options.wikiToken
        ? new Promise(() => {})
        : Promise.resolve(options.appToken!),
    );
    const resolved = jest.fn();
    void new TodayOperationsOverviewService(httpService)
      .getOverview()
      .then(resolved);
    await jest.advanceTimersByTimeAsync(10_001);
    expect(resolved).toHaveBeenCalled();
    expect(resolved.mock.calls[0][0].rackSummary).not.toBeNull();
    expect(resolved.mock.calls[0][0].sourceStates.events.status).toBe('failed');
  });

  it('coalesces simultaneous overview requests', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    const results = await Promise.all([
      service.getOverview(),
      service.getOverview(),
      service.getOverview(true),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(
      mockedFetch.mock.calls.filter(
        ([, options]) => options.tableId === 'tblBgaPzuVj7V9Q6',
      ),
    ).toHaveLength(1);
  });

  it('marks persisted rack records stale while refreshing them without blocking', async () => {
    const original = mockedFetch.getMockImplementation()!;
    mockedPersistedSnapshot.mockImplementation(async (options) =>
      options.tableId === 'tblBgaPzuVj7V9Q6'
        ? {
            records: rackLoads,
            fetchedAt: Date.now() - 600_000,
            expiresAt: Date.now() - 300_000,
          }
        : null,
    );
    mockedFetch.mockImplementation((http, options) =>
      options.tableId === 'tblBgaPzuVj7V9Q6'
        ? new Promise(() => {})
        : original(http, options),
    );
    const resolved = jest.fn();
    void new TodayOperationsOverviewService(httpService)
      .getOverview()
      .then(resolved);
    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalled();
    expect(resolved.mock.calls[0][0].rackSummary).not.toBeNull();
    expect(resolved.mock.calls[0][0].rackSourceState.status).toBe('stale');
  });

  it('recovers a failed rack on retry without losing successful operations', async () => {
    const original = mockedFetch.getMockImplementation()!;
    const service = new TodayOperationsOverviewService(httpService);
    mockedFetch.mockImplementation((http, options) =>
      options.tableId === 'tblBgaPzuVj7V9Q6'
        ? Promise.reject(new Error('offline'))
        : original(http, options),
    );
    const partial = await service.getOverview();
    await service.syncEventAndChangeSources();
    expect((await service.getOverview()).sourceStatus).toBe('partial');
    mockedFetch.mockImplementation(original);
    await jest.advanceTimersByTimeAsync(31_000);
    const recovered = await service.getOverview();
    expect(recovered.rackSummary).not.toBeNull();
    expect(recovered.sourceStatus).toBe('fresh');
    expect(recovered.details).toEqual(partial.details);
  });

  it('does not use yesterday rack or work snapshots as today data after rollover failure', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    await service.getOverview();
    jest.setSystemTime(new Date('2026-07-20T16:01:00.000Z'));
    mockedFetch.mockRejectedValue(new Error('offline'));
    const result = await service.getOverview();
    expect(result.businessDate).toBe('2026-07-21');
    expect(result.rackSummary).toBeNull();
    expect(
      Object.values(result.sourceStates).every(
        (source) => source.status === 'failed',
      ),
    ).toBe(true);
  });

  it('maps the registered source tables into rack and operations card data', async () => {
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();

    expect(result).toEqual({
      businessDate: '2026-07-20',
      sourceStatus: 'fresh',
      syncedAt: '2026-07-20T04:00:00.000Z',
      rackSummary: {
        usageRate: 74,
        online: 3700,
        total: 5000,
        buildingUsages: [
          { building: 'A楼', online: 800, total: 1000, usageRate: 80 },
          { building: 'B楼', online: 675, total: 900, usageRate: 75 },
          { building: 'C楼', online: 834, total: 1100, usageRate: 75.8 },
          { building: 'D楼', online: 401, total: 800, usageRate: 50.1 },
          { building: 'E楼', online: 990, total: 1200, usageRate: 82.5 },
        ],
        poweredOnThisWeek: 2,
        poweredOffThisWeek: 1,
        poweredOnWeekDelta: -5,
        poweredOffWeekDelta: -3,
        weekStartDate: '2026-07-20',
        capacityDate: '2026-07-19',
        loadDate: '2026-07-20',
        buildingLoads: [
          { building: 'A楼', value: 60 },
          { building: 'B楼', value: 70 },
          { building: 'C楼', value: 80 },
          { building: 'D楼', value: 50 },
          { building: 'E楼', value: 30 },
        ],
      },
      operations: {
        todayEvents: 2,
        pendingEvents: 2,
        priorPendingEvents: 1,
        closedTodayEvents: 1,
        keyEvents: 1,
        todayChanges: 4,
        activeChanges: 3,
        priorActiveChanges: 1,
        keyChanges: 2,
        todayInspections: 3,
        activeInspections: 2,
        todayMaintenance: 3,
        activeMaintenance: 1,
      },
      details: {
        events: [
          expect.objectContaining({
            id: 'event-closed',
            code: 'INC-001',
            title: 'A楼供电事件',
            level: 'I2',
            isKey: true,
          }),
          expect.objectContaining({
            id: 'event-open',
            code: 'INC-002',
            title: 'B楼空调事件',
            level: 'I3',
            owner: null,
            isKey: false,
          }),
        ],
        changes: [
          expect.objectContaining({
            id: 'change-finished',
            code: 'CHG-002',
            title: 'B楼网络调整',
            status: '已结束',
            isKey: true,
          }),
          expect.objectContaining({
            id: 'change-bad-end-year',
            riskLevel: '中风险',
            status: '进行中',
            isKey: true,
          }),
          expect.objectContaining({
            id: 'change-active',
            status: '进行中',
            building: 'A楼',
            specialty: '电气',
            isKey: false,
          }),
          expect.objectContaining({
            id: 'change-prior-active',
            title: '跨日变更',
            status: '进行中',
          }),
        ],
        inspections: expect.arrayContaining([
          expect.objectContaining({ id: 'inspection-active' }),
        ]),
        maintenance: expect.arrayContaining([
          expect.objectContaining({ id: 'maintenance-active' }),
        ]),
      },
      focusDetails: {
        pendingEvents: [
          expect.objectContaining({
            id: 'event-prior-open',
            title: 'C楼跨日未完成事件',
            isKey: true,
          }),
          expect.objectContaining({
            id: 'event-open',
            title: 'B楼空调事件',
          }),
        ],
        activeChanges: [
          expect.objectContaining({
            id: 'change-bad-end-year',
            title: 'C楼制冷优化',
          }),
          expect.objectContaining({
            id: 'change-active',
            title: 'A楼配电切换',
          }),
          expect.objectContaining({
            id: 'change-prior-active',
            title: '跨日变更',
          }),
        ],
      },
      sourceStates: {
        events: {
          status: 'fresh',
          errorCode: null,
          errorMessage: null,
        },
        changes: {
          status: 'fresh',
          errorCode: null,
          errorMessage: null,
        },
        inspections: {
          status: 'fresh',
          errorCode: null,
          errorMessage: null,
        },
        maintenance: {
          status: 'fresh',
          errorCode: null,
          errorMessage: null,
        },
      },
    });
  });

  it('counts cross-day changes marked for today in the card and detail list', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const crossDayActive = record('change-cross-day-active', {
      变更开始时间: Date.parse('2026-07-19T08:00:00+08:00'),
      变更结束时间: Date.parse('2026-07-22T18:00:00+08:00'),
      今日是否进行: ['是'],
      变更编码: 'CHG-CROSS-ACTIVE',
      变更简述: '跨日进行中的重点变更',
      '智航-变更等级': 'I2',
      '阿里-变更等级': '低',
    });
    const crossDayFinished = record('change-cross-day-finished', {
      变更开始时间: Date.parse('2026-07-19T08:00:00+08:00'),
      变更结束时间: Date.parse('2026-07-20T10:00:00+08:00'),
      实际结束时间: Date.parse('2026-07-20T10:10:00+08:00'),
      今日是否进行: ['是'],
      变更编码: 'CHG-CROSS-FINISHED',
      变更简述: '今日已结束的跨日变更',
      '智航-变更等级': 'I3',
      '阿里-变更等级': '中风险',
    });
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblYodlEKeWzqogu') {
        return [crossDayActive, crossDayFinished];
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();

    expect(result.operations.todayChanges).toBe(2);
    expect(result.operations.activeChanges).toBe(1);
    expect(result.operations.priorActiveChanges).toBe(0);
    expect(result.operations.keyChanges).toBe(2);
    expect(result.operations.todayChanges).toBe(result.details.changes.length);
    expect(result.details.changes.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'change-cross-day-active',
        'change-cross-day-finished',
      ]),
    );
  });

  it('includes unmarked cross-day active changes in today counts and details', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const crossDayActive = record('change-cross-day-unmarked-active', {
      变更开始时间: Date.parse('2026-07-19T08:00:00+08:00'),
      变更结束时间: Date.parse('2026-07-23T18:00:00+08:00'),
      今日是否进行: '否',
      变更编码: 'CHG-CROSS-UNMARKED',
      变更简述: '跨日仍在进行的变更',
      '智航-变更等级': 'I3',
      '阿里-变更等级': '低',
    });
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblYodlEKeWzqogu') {
        return [crossDayActive];
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();

    expect(result.operations.todayChanges).toBe(1);
    expect(result.operations.activeChanges).toBe(1);
    expect(result.operations.priorActiveChanges).toBe(1);
    expect(result.details.changes.map((item) => item.id)).toEqual([
      'change-cross-day-unmarked-active',
    ]);
  });

  it('refreshes only event and change sources on the five-minute background timer', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    service.onModuleInit();
    await service.syncEventAndChangeSources();
    mockedFetch.mockClear();

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(mockedFetch).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const refreshedTableIds = mockedFetch.mock.calls.map(
      ([, options]) => options.tableId,
    );

    expect(refreshedTableIds).toEqual(['tblj9XJLq5QzTAqX', 'tblYodlEKeWzqogu']);
    service.onModuleDestroy();
  });

  it('merges a targeted event and change refresh into the current overview snapshot', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    const initial = await service.getOverview();
    const defaultImplementation = mockedFetch.getMockImplementation();
    const newEvent = record('event-new', {
      事件发生时间: Date.parse('2026-07-20T12:30:00+08:00'),
      最终状态: ['响应跟进'],
      事件编号: 'INC-NEW',
      事件简述: '后台同步新增事件',
      事件等级: 'I2',
    });
    const newChange = record('change-new', {
      变更开始时间: Date.parse('2026-07-19T08:00:00+08:00'),
      变更结束时间: Date.parse('2026-07-21T08:00:00+08:00'),
      今日是否进行: ['是'],
      变更编码: 'CHG-NEW',
      变更简述: '后台同步新增变更',
      '智航-变更等级': 'I3',
      '阿里-变更等级': '低',
    });
    mockedFetch.mockImplementation(async (http, options) => {
      if (options.tableId === 'tblj9XJLq5QzTAqX') {
        return [...allEvents, newEvent];
      }
      if (options.tableId === 'tblYodlEKeWzqogu') {
        return [newChange];
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(http, options);
    });
    mockedFetch.mockClear();

    await service.syncEventAndChangeSources();
    const refreshed = await service.getOverview();

    expect(initial.operations.todayEvents).toBe(2);
    expect(refreshed.operations.todayEvents).toBe(3);
    expect(refreshed.operations.todayChanges).toBe(1);
    expect(refreshed.details.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'event-new' })]),
    );
    expect(refreshed.details.changes).toEqual([
      expect.objectContaining({ id: 'change-new' }),
    ]);
    expect(
      mockedFetch.mock.calls.map(([, options]) => options.tableId),
    ).toEqual(['tblj9XJLq5QzTAqX', 'tblYodlEKeWzqogu']);
  });

  it('renews the fast snapshot window after a targeted event and change refresh', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    await service.getOverview();

    jest.advanceTimersByTime(4 * 60 * 1000);
    await service.syncEventAndChangeSources();
    mockedFetch.mockClear();
    jest.advanceTimersByTime(2 * 60 * 1000);

    const result = await service.getOverview();

    expect(result.businessDate).toBe('2026-07-20');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('does not renew a stale overview snapshot after a targeted event and change refresh', async () => {
    let maintenanceSnapshotReads = 0;
    mockedPersistedSnapshot.mockImplementation(async (options) => {
      if (options.tableId !== 'tblk7QuEsiE4p3nZ') {
        return null;
      }
      maintenanceSnapshotReads += 1;
      return maintenanceSnapshotReads === 1
        ? {
            records: maintenanceRows,
            fetchedAt: Date.parse('2026-07-20T03:54:00.000Z'),
            expiresAt: Date.parse('2026-07-20T03:59:00.000Z'),
          }
        : null;
    });
    const service = new TodayOperationsOverviewService(httpService);

    const stale = await service.getOverview();
    expect(stale.sourceStatus).toBe('stale');

    jest.advanceTimersByTime(4 * 60 * 1000);
    await service.syncEventAndChangeSources();
    mockedFetch.mockClear();
    jest.advanceTimersByTime(2 * 60 * 1000);

    const refreshed = await service.getOverview();

    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblk7QuEsiE4p3nZ',
      }),
    );
    expect(refreshed.sourceStatus).toBe('fresh');
  });

  it('coalesces concurrent background syncs into one event and change request', async () => {
    let releaseEvents!: (records: BitableRecordItem[]) => void;
    const eventGate = new Promise<BitableRecordItem[]>((resolve) => {
      releaseEvents = resolve;
    });
    const defaultImplementation = mockedFetch.getMockImplementation();
    mockedFetch.mockImplementation(async (http, options) => {
      if (options.tableId === 'tblj9XJLq5QzTAqX') {
        return eventGate;
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(http, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const first = service.syncEventAndChangeSources();
    const second = service.syncEventAndChangeSources();

    expect(second).toBe(first);
    releaseEvents(allEvents);
    await Promise.all([first, second]);
    expect(
      mockedFetch.mock.calls.filter(
        ([, options]) => options.tableId === 'tblj9XJLq5QzTAqX',
      ),
    ).toHaveLength(1);
    expect(
      mockedFetch.mock.calls.filter(
        ([, options]) => options.tableId === 'tblYodlEKeWzqogu',
      ),
    ).toHaveLength(1);
  });

  it('keeps the last event and change counts during the short retry backoff after a targeted refresh fails', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    const initial = await service.getOverview();
    const defaultImplementation = mockedFetch.getMockImplementation();
    mockedFetch.mockImplementation(async (http, options) => {
      if (
        options.tableId === 'tblj9XJLq5QzTAqX' ||
        options.tableId === 'tblYodlEKeWzqogu'
      ) {
        throw new Error('temporary source outage');
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(http, options);
    });

    await service.syncEventAndChangeSources();
    mockedFetch.mockClear();
    const stale = await service.getOverview();

    expect(stale.operations.todayEvents).toBe(initial.operations.todayEvents);
    expect(stale.operations.todayChanges).toBe(initial.operations.todayChanges);
    expect(stale.details.events).toEqual(initial.details.events);
    expect(stale.details.changes).toEqual(initial.details.changes);
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.sourceStates.events.status).toBe('stale');
    expect(stale.sourceStates.changes.status).toBe('stale');
    expect(mockedFetch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000);
    await service.getOverview();

    expect(mockedFetch).toHaveBeenCalled();
  });

  it('maps inspection and maintenance rows into real detail fields', async () => {
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();

    expect(result.details.inspections).toEqual([
      expect.objectContaining({
        id: 'inspection-active',
        title: 'A楼柴油机冷却系统检修',
        status: '进行中',
        method: '计划检修',
        startTime: '2026-07-20T15:30:00.000Z',
        endTime: '2026-07-21T16:30:00.000Z',
        building: 'A楼',
        specialty: '暖通',
        durationDays: 3,
      }),
      expect.objectContaining({
        id: 'inspection-finished',
        title: 'B楼配电柜检修',
        status: '已结束',
        method: '故障维修',
        building: 'B楼',
        durationDays: 1,
      }),
      expect.objectContaining({
        id: 'inspection-unknown',
        method: null,
        status: '进行中',
        durationDays: null,
      }),
    ]);
    expect(result.details.maintenance).toEqual([
      expect.objectContaining({
        id: 'maintenance-active',
        title: 'A楼冷机年度维保',
        building: 'A楼',
      }),
      expect.objectContaining({
        id: 'maintenance-finished',
        title: 'B楼消防系统维保',
        building: 'B楼',
      }),
      expect.objectContaining({
        id: 'maintenance-not-started',
        title: '维保记录 3',
        building: null,
      }),
    ]);
  });

  it('loads view-scoped inspection and maintenance rows without formula filters', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    mockedFetch.mockImplementation(async (service, options) => {
      if (
        (options.tableId === 'tblk7QuEsiE4p3nZ' ||
          options.tableId === 'tblpaHktT0mn0hwg') &&
        options.filter
      ) {
        throw Object.assign(new Error('InvalidFilter'), {
          feishuCode: 1254018,
        });
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview(true);

    expect(result.sourceStatus).toBe('fresh');
    expect(result.sourceStates.maintenance.status).toBe('fresh');
    expect(result.sourceStates.inspections.status).toBe('fresh');
    expect(result.details.maintenance).not.toHaveLength(0);
    expect(result.details.inspections).not.toHaveLength(0);
  });

  it('skips a complete shift group whose required rack-change value is missing', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const invalidShiftRows = shiftRows(
      '2026-07-18',
      '白班',
      [1, 4, 0, 0, 0],
      [0, 0, 3, 0, 0],
    ).map((item, index) =>
      index === 0
        ? {
            ...item,
            fields: {
              ...item.fields,
              '本班组上电机柜数（个）': undefined,
            },
          }
        : item,
    );
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblz8rjxdtRRlYmS') {
        return [...invalidShiftRows, ...rackShiftRows];
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });

    const service = new TodayOperationsOverviewService(httpService);

    await expect(service.getOverview()).resolves.toEqual(
      expect.objectContaining({
        rackSummary: expect.objectContaining({
          poweredOnThisWeek: 2,
          poweredOffThisWeek: 1,
          poweredOnWeekDelta: -5,
          poweredOffWeekDelta: -3,
        }),
      }),
    );
  });

  it('uses persisted-first reads and avoids duplicate event and change queries', async () => {
    const service = new TodayOperationsOverviewService(httpService);

    await service.getOverview();

    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblBgaPzuVj7V9Q6',
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '日期',
              operator: 'is',
              value: ['ExactDate', '1784476800000'],
            },
          ],
        },
        strict: true,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblz8rjxdtRRlYmS',
        filter: expect.objectContaining({ conjunction: 'and' }),
        fieldNames: expect.arrayContaining(['楼栋', '日期', '班次']),
        forceRefresh: true,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblDYQYihJ0CgepE',
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '年度', operator: 'is', value: ['2026'] },
            { field_name: '月度', operator: 'is', value: ['07'] },
          ],
        },
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblj9XJLq5QzTAqX',
        filter: undefined,
        fieldNames: undefined,
        forceRefresh: true,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblYodlEKeWzqogu',
        filter: undefined,
        fieldNames: undefined,
        forceRefresh: true,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblk7QuEsiE4p3nZ',
        viewId: 'vewJoQQzSc',
        fieldNames: undefined,
        filter: undefined,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tblpaHktT0mn0hwg',
        viewId: 'vewCwJvtXN',
        fieldNames: undefined,
        filter: undefined,
      }),
    );
    expect(
      mockedFetch.mock.calls.filter(
        ([, options]) => options.tableId === 'tblj9XJLq5QzTAqX',
      ),
    ).toHaveLength(1);
    expect(
      mockedFetch.mock.calls.filter(
        ([, options]) => options.tableId === 'tblYodlEKeWzqogu',
      ),
    ).toHaveLength(1);
    expect(mockedFetch).toHaveBeenCalledTimes(7);
  });

  it('waits for Feishu only when a refresh is explicitly requested', async () => {
    const service = new TodayOperationsOverviewService(httpService);

    await service.getOverview(true);

    expect(mockedFetch).toHaveBeenCalled();
    expect(
      mockedFetch.mock.calls.every(([, options]) => options.forceRefresh),
    ).toBe(true);
  });

  it('does not reuse a still-live overview snapshot after the Shanghai business date changes', async () => {
    jest.setSystemTime(new Date('2026-07-20T15:59:50.000Z'));
    const service = new TodayOperationsOverviewService(httpService);
    const first = await service.getOverview();
    const callsBeforeMidnight = mockedFetch.mock.calls.length;

    jest.setSystemTime(new Date('2026-07-20T16:00:10.000Z'));
    const nextDay = await service.getOverview();

    expect(first.businessDate).toBe('2026-07-20');
    expect(nextDay.businessDate).toBe('2026-07-21');
    expect(nextDay.syncedAt).toBe('2026-07-20T16:00:10.000Z');
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(callsBeforeMidnight);
  });

  it('isolates a Feishu 10014 detail-source failure and rejects the previous-day persisted snapshot', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const sourceError = Object.assign(new Error('upstream rejected'), {
      feishuCode: 10014,
      status: 200,
    });
    mockedPersistedSnapshot.mockImplementation(async (options) =>
      options.tableId === 'tblk7QuEsiE4p3nZ'
        ? {
            records: maintenanceRows,
            fetchedAt: Date.parse('2026-07-19T04:00:00.000Z'),
            expiresAt: Date.parse('2026-07-19T04:05:00.000Z'),
          }
        : null,
    );
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblk7QuEsiE4p3nZ') {
        throw sourceError;
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();

    expect(result.sourceStatus).toBe('partial');
    expect(result.details.maintenance).toEqual([]);
    expect(result.operations.todayMaintenance).toBe(0);
    expect(result.details.inspections).toHaveLength(3);
    expect(result.sourceStates.maintenance).toEqual({
      status: 'failed',
      errorCode: '10014',
      errorMessage: '今日维保数据源暂时不可用',
    });
    expect(result.sourceStates.inspections.status).toBe('fresh');

    const callsAfterPartial = mockedFetch.mock.calls.length;
    jest.advanceTimersByTime(31_000);
    if (!defaultImplementation) {
      throw new Error('Missing default test implementation');
    }
    mockedFetch.mockImplementation(defaultImplementation);

    const recovered = await service.getOverview();

    expect(recovered.sourceStatus).toBe('fresh');
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(callsAfterPartial);
  });

  it('uses only a same-business-day persisted detail snapshot when a forced refresh fails', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const sourceError = Object.assign(new Error('upstream rejected'), {
      feishuCode: 10014,
      status: 200,
    });
    mockedPersistedSnapshot.mockImplementation(async (options) =>
      options.tableId === 'tblk7QuEsiE4p3nZ'
        ? {
            records: maintenanceRows,
            fetchedAt: Date.parse('2026-07-20T03:30:00.000Z'),
            expiresAt: Date.parse('2026-07-20T03:35:00.000Z'),
          }
        : null,
    );
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblk7QuEsiE4p3nZ') {
        throw sourceError;
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });
    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview(true);

    expect(result.sourceStatus).toBe('stale');
    expect(result.details.maintenance).toHaveLength(3);
    expect(result.sourceStates.maintenance).toEqual({
      status: 'stale',
      errorCode: '10014',
      errorMessage: '今日维保数据源刷新失败，已展示本日缓存',
    });
  });

  it('warns with sanitized source metadata when an expired snapshot background refresh fails', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const defaultImplementation = mockedFetch.getMockImplementation();
      const sourceError = Object.assign(new Error('InvalidFilter'), {
        feishuCode: 1254018,
      });
      let maintenanceSnapshotReads = 0;
      mockedPersistedSnapshot.mockImplementation(async (options) => {
        if (options.tableId !== 'tblk7QuEsiE4p3nZ') {
          return null;
        }
        maintenanceSnapshotReads += 1;
        return maintenanceSnapshotReads === 1
          ? {
              records: maintenanceRows,
              fetchedAt: Date.parse('2026-07-20T03:54:00.000Z'),
              expiresAt: Date.parse('2026-07-20T03:59:00.000Z'),
            }
          : null;
      });
      mockedFetch.mockImplementation(async (service, options) => {
        if (options.tableId === 'tblk7QuEsiE4p3nZ') {
          throw sourceError;
        }
        if (!defaultImplementation) {
          throw new Error('Missing default test implementation');
        }
        return defaultImplementation(service, options);
      });
      const service = new TodayOperationsOverviewService(httpService);

      const result = await service.getOverview();
      await Promise.resolve();
      await Promise.resolve();

      expect(result.sourceStatus).toBe('stale');
      const loggedWarnings = JSON.stringify(warnSpy.mock.calls);
      expect(loggedWarnings).toContain('今日全景维保');
      expect(loggedWarnings).toContain('tblk7QuEsiE4p3nZ');
      expect(loggedWarnings).toContain('1254018');
      expect(loggedWarnings).not.toContain('InvalidFilter');
      expect(loggedWarnings).not.toContain('resolved-notice-app');
      expect(loggedWarnings).not.toMatch(/appToken|appSecret|response/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns the last successful dashboard as stale when a forced refresh fails', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    const fresh = await service.getOverview();
    mockedFetch.mockRejectedValue(new Error('temporary source outage'));

    const stale = await service.getOverview(true);

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.rackSummary).toEqual(fresh.rackSummary);
    expect(stale.details).toEqual(fresh.details);
    expect(stale.rackSourceState?.status).toBe('stale');
    expect(
      Object.values(stale.sourceStates).every(
        (source) => source.status === 'stale',
      ),
    ).toBe(true);
  });

  it('retries automatically after the short stale-data backoff expires', async () => {
    const service = new TodayOperationsOverviewService(httpService);
    const defaultImplementation = mockedFetch.getMockImplementation();
    await service.getOverview();
    mockedFetch.mockRejectedValue(new Error('temporary source outage'));
    await service.getOverview(true);
    const callsAfterFailure = mockedFetch.mock.calls.length;

    jest.advanceTimersByTime(31_000);
    if (!defaultImplementation) {
      throw new Error('Missing default test implementation');
    }
    mockedFetch.mockImplementation(defaultImplementation);
    const refreshed = await service.getOverview();

    expect(refreshed.sourceStatus).toBe('fresh');
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });

  it('rejects a complete-looking building set when a required rack value is missing', async () => {
    const defaultImplementation = mockedFetch.getMockImplementation();
    const invalidMonthly = rackMonthly.map((item, index) =>
      index === 0
        ? {
            ...item,
            fields: {
              ...item.fields,
              机柜设计数量: undefined,
            },
          }
        : item,
    );
    mockedFetch.mockImplementation(async (service, options) => {
      if (options.tableId === 'tblDYQYihJ0CgepE') {
        return invalidMonthly;
      }
      if (!defaultImplementation) {
        throw new Error('Missing default test implementation');
      }
      return defaultImplementation(service, options);
    });

    const service = new TodayOperationsOverviewService(httpService);

    const result = await service.getOverview();
    expect(result.rackSummary).toBeNull();
    expect(result.sourceStatus).toBe('partial');
  });

  it.each([
    ['total undefined', '机柜设计数量', undefined],
    ['total non-numeric text', '机柜设计数量', 'not-a-number'],
    ['total zero', '机柜设计数量', formulaNumber(0)],
    ['total negative', '机柜设计数量', formulaNumber(-1)],
    ['online undefined', '实际上电数量', undefined],
    ['online non-numeric text', '实际上电数量', 'not-a-number'],
    ['online negative', '实际上电数量', formulaNumber(-1)],
  ] as const)(
    'rejects a single building with %s',
    async (_caseName, fieldName, fieldValue) => {
      const defaultImplementation = mockedFetch.getMockImplementation();
      const invalidMonthly = rackMonthly.map((item, index) =>
        index === 0
          ? {
              ...item,
              fields: {
                ...item.fields,
                [fieldName]: fieldValue,
              },
            }
          : item,
      );
      mockedFetch.mockImplementation(async (service, options) => {
        if (options.tableId === 'tblDYQYihJ0CgepE') {
          return invalidMonthly;
        }
        if (!defaultImplementation) {
          throw new Error('Missing default test implementation');
        }
        return defaultImplementation(service, options);
      });

      const service = new TodayOperationsOverviewService(httpService);

      const result = await service.getOverview();
      expect(result.rackSummary).toBeNull();
      expect(result.sourceStatus).toBe('partial');
    },
  );
});
