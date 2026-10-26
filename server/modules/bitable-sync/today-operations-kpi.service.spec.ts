jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

jest.mock('../../common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('../../common/feishu/leave-approval-source'),
  fetchLeaveApprovalSnapshot: jest.fn(),
  enrichScheduleRecordsWithLeaveApproval: jest.fn(),
}));

import type { HttpService } from '@nestjs/axios';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  enrichScheduleRecordsWithLeaveApproval,
  fetchLeaveApprovalSnapshot,
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
  SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD,
} from '../../common/feishu/leave-approval-source';
import { TodayOperationsKpiService } from './today-operations-kpi.service';

const mockedFetch = jest.mocked(fetchBitableRecords);
const mockedPersistedSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedResolve = jest.mocked(resolveBitableAppToken);
const mockedFetchLeaveApprovalSnapshot = jest.mocked(
  fetchLeaveApprovalSnapshot,
);
const mockedEnrichScheduleRecordsWithLeaveApproval = jest.mocked(
  enrichScheduleRecordsWithLeaveApproval,
);
const httpService = {} as HttpService;
const buildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;

function record(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

function formulaNumber(value: number): Record<string, unknown> {
  return { type: 2, value: [value] };
}

function staffNames(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s、,，;；/]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function datedBuildingRows(
  prefix: string,
  fieldName: string,
  currentValues: number[],
  previousValues: number[],
  dateField = '日期',
  baselineValues?: number[],
): BitableRecordItem[] {
  return [
    ...buildings.map((building, index) =>
      record(`${prefix}-current-${building}`, {
        楼栋: building,
        [dateField]: Date.parse('2026-07-19T00:00:00+08:00'),
        [fieldName]: formulaNumber(currentValues[index]),
      }),
    ),
    ...buildings.map((building, index) =>
      record(`${prefix}-previous-${building}`, {
        楼栋: building,
        [dateField]: Date.parse('2026-07-18T00:00:00+08:00'),
        [fieldName]: formulaNumber(previousValues[index]),
      }),
    ),
    ...(baselineValues || []).map((value, index) =>
      record(`${prefix}-baseline-${buildings[index]}`, {
        楼栋: buildings[index],
        [dateField]: Date.parse('2026-07-17T00:00:00+08:00'),
        [fieldName]: formulaNumber(value),
      }),
    ),
  ];
}

const sourceRecords: Record<string, BitableRecordItem[]> = {
  tblc52553f0930da: [
    record('safety', {
      起始日期: Date.parse('2018-10-26T00:00:00+08:00'),
      安全运行天数: formulaNumber(2824),
    }),
  ],
  PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID: [
    record('today-long-white-a', {
      排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
      机楼: 'A楼',
      班组: '长白',
      班次: '白班',
      '值班人员（实际）程序修改': '示例人员008、示例人员013、周九、重复人、替班甲、缺岗甲',
      请假人员: '示例人员013',
      '请假人员(辅助)': '示例人员013',
      替班人员: '替班乙',
      缺岗替班人员: '缺岗乙',
      差旅人员: '示例人员008',
      员工工号: '1001',
      联系电话: '13800009626',
    }),
    record('today-long-white-b', {
      排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
      机楼: 'B楼',
      班组: '长白',
      班次: '白班',
      '值班人员（实际）程序修改': '重复人、孙七、替班乙、缺岗乙',
    }),
    ...['H楼', 'C楼', 'D楼', 'E楼'].map((building) =>
      record(`today-long-white-coverage-${building}`, {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: building,
        班组: '长白',
        班次: '白班',
        请假人员: `仅覆盖-${building}`,
        '请假人员(辅助)': `仅覆盖-${building}`,
      }),
    ),
    record('yesterday-long-white', {
      排班日期: Date.parse('2026-07-19T00:00:00+08:00'),
      机楼: 'C楼',
      班组: '长白',
      班次: '白班',
      '值班人员（实际）程序修改': '昨日人员',
    }),
    record('today-shift-team', {
      排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
      机楼: 'D楼',
      班组: 'A班',
      班次: '白班',
      '值班人员（实际）程序修改': '倒班人员',
    }),
    record('today-night-shift', {
      排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
      机楼: 'E楼',
      班组: '长白',
      班次: '夜班',
      '值班人员（实际）程序修改': '夜班人员',
    }),
    ...['H楼', 'A楼', 'B楼', 'C楼', 'D楼'].map((building) =>
      record(`today-night-coverage-${building}`, {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: building,
        班组: 'B班',
        班次: '夜班',
        请假人员: `夜班仅覆盖-${building}`,
        '请假人员(辅助)': `夜班仅覆盖-${building}`,
      }),
    ),
  ],
  tbl32bf112724ed6: datedBuildingRows(
    'pue',
    'PUE',
    [1.2, 1.3, 1.4, 9.9, 19.9],
    [1.1, 1.2, 1.3, 8.8, 18.8],
    '日期',
    [1.0, 1.1, 1.2, 7.7, 17.7],
  ).map((item) => ({
    ...item,
    fields: { ...item.fields, 汇总分类: 'PUE' },
  })),
  tbl35e641004a831: datedBuildingRows(
    'it-load',
    'IT负载率',
    [0.6, 0.62, 0.64, 0.4, 0.3],
    [0.58, 0.6, 0.62, 0.38, 0.28],
  ).map((item) => ({
    ...item,
    fields: {
      ...item.fields,
      园区IT负载率: formulaNumber(
        String(item.record_id).includes('current') ? 0.512 : 0.5,
      ),
    },
  })),
  tbl4ee10540b26b2: datedBuildingRows(
    'electricity',
    '用电量',
    [200_000, 200_000, 200_000, 200_000, 200_000],
    [190_000, 190_000, 190_000, 190_000, 190_000],
    '日期',
    [180_000, 180_000, 180_000, 180_000, 180_000],
  ).map((item) => ({
    ...item,
    fields: { ...item.fields, 项目: '变压器总进线' },
  })),
  tbl85eb2123a63c8: datedBuildingRows(
    'water',
    '当日耗水总量（实际）',
    [300, 300, 300, 300, 300],
    [280, 280, 280, 280, 280],
    '执行日期',
    [260, 260, 260, 260, 260],
  ).map((item) => ({
    ...item,
    fields: { ...item.fields, 类型: '水耗', 频次: '日' },
  })),
};

describe('TodayOperationsKpiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T04:00:00.000Z'));
    mockedResolve.mockImplementation(
      async (_httpService, options) => options.appToken || 'resolved-wiki-app',
    );
    mockedPersistedSnapshot.mockResolvedValue(null);
    mockedFetchLeaveApprovalSnapshot.mockResolvedValue({
      verified: true,
      requests: [],
    });
    mockedEnrichScheduleRecordsWithLeaveApproval.mockImplementation(
      (records, snapshot) =>
        records.map((item) => {
          const fields = item.fields ?? {};
          const rawLeaveStaff = staffNames(fields['请假人员']);
          const helperStaff = new Set(staffNames(fields['请假人员(辅助)']));
          const approvedLeaveStaff = snapshot.verified
            ? rawLeaveStaff.filter((name) => helperStaff.has(name))
            : [];
          const approvedSubstituteStaff =
            approvedLeaveStaff.length > 0 &&
            approvedLeaveStaff.length === rawLeaveStaff.length
              ? staffNames(fields['替班人员'])
              : [];
          return {
            ...item,
            fields: {
              ...fields,
              [SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]: snapshot.verified,
              [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]: approvedLeaveStaff,
              [SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]: approvedSubstituteStaff,
            },
          };
        }),
    );
    mockedFetch.mockImplementation(async (_httpService, options) => {
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      return rows;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps four complete periods for anomaly scans when today already has data', async () => {
    const dateFields: Record<string, string> = {
      tbl32bf112724ed6: '日期',
      tbl4ee10540b26b2: '日期',
      tbl85eb2123a63c8: '执行日期',
    };
    mockedFetch.mockImplementation(async (_httpService, options) => {
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      const dateField = dateFields[options.tableId];
      if (!dateField) return rows;
      return [
        ...rows
          .filter((item) => item.record_id?.includes('-current-'))
          .map((item) => record(`today-${item.record_id}`, {
            ...item.fields,
            [dateField]: Date.parse('2026-07-20T00:00:00+08:00'),
          })),
        ...rows,
      ];
    });
    const service = new TodayOperationsKpiService(httpService);

    const scan = await service.getKpisForAnomalyScan();
    const page = await service.getKpis();

    for (const metric of ['averagePue', 'electricityKwh', 'waterTons'] as const) {
      expect(scan.details.buildingMetrics[metric].history.map(({ date }) => date)).toEqual([
        '2026-07-20', '2026-07-19', '2026-07-18', '2026-07-17',
      ]);
      expect(page.details.buildingMetrics[metric].history).toHaveLength(3);
    }
  });

  it('anchors a backfilled anomaly scan to its patrol business date', async () => {
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpisForAnomalyScan('2026-07-19');

    expect(result.metrics.safeOperationDays.date).toBe('2026-07-19');
  });

  it('maps all six registered sources using the latest two complete business dates', async () => {
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();

    expect(result).toMatchObject({
      sourceStatus: 'fresh',
      syncedAt: '2026-07-20T04:00:00.000Z',
      metrics: {
        safeOperationDays: {
          value: 2824,
          previousValue: null,
          date: '2026-07-20',
        },
        onDutyPeople: {
          value: 8,
          previousValue: null,
          date: '2026-07-20',
        },
        averagePue: {
          value: 1.3,
          previousValue: 1.2,
          date: '2026-07-19',
        },
        itLoadRate: {
          value: 51.2,
          previousValue: 50,
          date: '2026-07-19',
        },
        electricityKwh: {
          value: 1_000_000,
          previousValue: 950_000,
          date: '2026-07-19',
        },
        waterTons: {
          value: 1500,
          previousValue: 1400,
          date: '2026-07-19',
        },
      },
      details: {
        onDutyPeople: {
          scope: 'daily_shifts',
          date: '2026-07-20',
          total: 8,
          whiteShiftTotal: 8,
          nightShiftTotal: 1,
        },
        buildingMetrics: {
          averagePue: {
            date: '2026-07-19',
            previousDate: '2026-07-18',
            includedBuildings: ['A楼', 'B楼', 'C楼'],
            rows: [
              { building: 'A楼', value: 1.2, previousValue: 1.1 },
              { building: 'B楼', value: 1.3, previousValue: 1.2 },
              { building: 'C楼', value: 1.4, previousValue: 1.3 },
              { building: 'D楼', value: 9.9, previousValue: 8.8 },
              { building: 'E楼', value: 19.9, previousValue: 18.8 },
            ],
          },
          electricityKwh: {
            date: '2026-07-19',
            previousDate: '2026-07-18',
            includedBuildings: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'],
            rows: buildings.map((building) => ({
              building,
              value: 200_000,
              previousValue: 190_000,
            })),
          },
          waterTons: {
            date: '2026-07-19',
            previousDate: '2026-07-18',
            includedBuildings: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'],
            rows: buildings.map((building) => ({
              building,
              value: 300,
              previousValue: 280,
            })),
          },
        },
      },
    });
    expect(result.details.onDutyPeople.buildings).toBe(
      result.details.onDutyPeople.shifts.white.buildings,
    );
    expect(
      (result.details.buildingMetrics?.averagePue as any).history,
    ).toEqual([
      {
        date: '2026-07-19',
        rows: [
          { building: 'A楼', value: 1.2 },
          { building: 'B楼', value: 1.3 },
          { building: 'C楼', value: 1.4 },
        ],
      },
      {
        date: '2026-07-18',
        rows: [
          { building: 'A楼', value: 1.1 },
          { building: 'B楼', value: 1.2 },
          { building: 'C楼', value: 1.3 },
        ],
      },
      {
        date: '2026-07-17',
        rows: [
          { building: 'A楼', value: 1 },
          { building: 'B楼', value: 1.1 },
          { building: 'C楼', value: 1.2 },
        ],
      },
    ]);

    expect(mockedFetch).toHaveBeenCalledTimes(6);
    expect(mockedFetchLeaveApprovalSnapshot).toHaveBeenCalledWith(httpService, {
      forceRefresh: false,
    });
    expect(mockedEnrichScheduleRecordsWithLeaveApproval).toHaveBeenCalledWith(
      sourceRecords.PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID,
      expect.objectContaining({ verified: true }),
    );
    expect(
      mockedFetch.mock.calls.every(
        ([, options]) => options.forceRefresh === false,
      ),
    ).toBe(true);
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID',
        viewId: 'vew6jLlGzq',
        fieldNames: undefined,
      }),
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tbl4ee10540b26b2',
        filter: expect.objectContaining({
          conditions: expect.arrayContaining([
            expect.objectContaining({
              field_name: '项目',
              value: ['变压器总进线'],
            }),
          ]),
        }),
      }),
    );
  });

  it('computes average PUE from A-C without requiring D or E rows', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      if (options.tableId !== 'tbl32bf112724ed6') return rows;
      return rows.filter((item) =>
        ['A楼', 'B楼', 'C楼'].includes(String(item.fields?.['楼栋'] ?? '')),
      );
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();

    expect(result.metrics.averagePue).toEqual({
      value: 1.3,
      previousValue: 1.2,
      date: '2026-07-19',
    });
    expect(result.details.buildingMetrics.averagePue).toMatchObject({
      date: '2026-07-19',
      previousDate: '2026-07-18',
      includedBuildings: ['A楼', 'B楼', 'C楼'],
      rows: [
        { building: 'A楼', value: 1.2, previousValue: 1.1 },
        { building: 'B楼', value: 1.3, previousValue: 1.2 },
        { building: 'C楼', value: 1.4, previousValue: 1.3 },
        { building: 'D楼', value: null, previousValue: null },
        { building: 'E楼', value: null, previousValue: null },
      ],
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      httpService,
      expect.objectContaining({
        tableId: 'tbl32bf112724ed6',
        tableName: '机楼每日用电汇总',
      }),
    );
  });

  it('falls back when the latest PUE period has a building row without a numeric value', async () => {
    mockedFetch.mockImplementation(async (_httpService, options) => {
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      if (options.tableId !== 'tbl32bf112724ed6') return rows;
      return rows.map((item) =>
        item.record_id === 'pue-current-A楼'
          ? {
              ...item,
              fields: {
                ...item.fields,
                PUE: null,
              },
            }
          : item,
      );
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();

    expect(result.metrics.averagePue).toEqual({
      value: 1.2,
      previousValue: 1.1,
      date: '2026-07-18',
    });
    expect(result.details.buildingMetrics.averagePue).toEqual({
      date: '2026-07-18',
      previousDate: '2026-07-17',
      includedBuildings: ['A楼', 'B楼', 'C楼'],
      rows: [
        { building: 'A楼', value: 1.1, previousValue: 1 },
        { building: 'B楼', value: 1.2, previousValue: 1.1 },
        { building: 'C楼', value: 1.3, previousValue: 1.2 },
        { building: 'D楼', value: 8.8, previousValue: 7.7 },
        { building: 'E楼', value: 18.8, previousValue: 17.7 },
      ],
      history: [
        {
          date: '2026-07-18',
          rows: [
            { building: 'A楼', value: 1.1 },
            { building: 'B楼', value: 1.2 },
            { building: 'C楼', value: 1.3 },
          ],
        },
        {
          date: '2026-07-17',
          rows: [
            { building: 'A楼', value: 1 },
            { building: 'B楼', value: 1.1 },
            { building: 'C楼', value: 1.2 },
          ],
        },
      ],
    });
  });

  it('serves its memory snapshot on normal reads and only forces Feishu on explicit refresh', async () => {
    const service = new TodayOperationsKpiService(httpService);

    await service.getKpis();
    await service.getKpis();
    expect(mockedFetch).toHaveBeenCalledTimes(6);

    await service.getKpis(true);
    expect(mockedFetch).toHaveBeenCalledTimes(12);
    expect(
      mockedFetch.mock.calls
        .slice(6)
        .every(([, options]) => options.forceRefresh === true),
    ).toBe(true);
  });

  it('uses the deduplicated white-shift list for the metric and keeps night separate', async () => {
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();
    const whiteStaff =
      result.details.onDutyPeople.shifts.white.buildings.flatMap(
        (building) => building.staff,
      );
    const nightStaff =
      result.details.onDutyPeople.shifts.night.buildings.flatMap(
        (building) => building.staff,
      );

    expect(result.metrics.onDutyPeople.value).toBe(
      result.details.onDutyPeople.whiteShiftTotal,
    );
    expect(new Set([...whiteStaff, ...nightStaff]).size).toBe(
      whiteStaff.length + nightStaff.length,
    );
    expect(whiteStaff).toContain('倒班人员');
    expect(nightStaff).toContain('夜班人员');
    expect(whiteStaff).not.toEqual(
      expect.arrayContaining(['示例人员008', '示例人员013', '昨日人员', '夜班人员']),
    );
  });

  it('maps white and night shifts with deduplicated people and attendance statuses', async () => {
    const personnelRows = [
      record('white-shift-a', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'A楼',
        班组: 'A班',
        班次: '白',
        '值班人员（实际）程序修改':
          '白一、请假甲、调休甲、替班甲、补位甲、跨班重复、跨状态人、差旅甲',
        请假人员: '请假甲',
        '请假人员(辅助)': '请假甲',
        调休人员: '调休甲',
        替班人员: '替班甲',
        缺岗替班人员: '补位甲',
        差旅人员: '差旅甲',
        员工工号: '1001',
        联系电话: '13800009626',
      }),
      record('long-white-b', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'B楼',
        班组: '长白',
        班次: '长白',
        '值班人员（实际）程序修改': '长白一、跨楼重复',
      }),
      record('white-shift-c', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'C楼',
        班组: 'A班',
        班次: '白',
        '值班人员（实际）程序修改': '跨楼重复',
      }),
      record('night-shift-a', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'A楼',
        班组: 'B班',
        班次: '夜',
        '值班人员（实际）程序修改': '夜一、跨班重复、夜请假、跨状态人',
        请假人员: '夜请假、跨状态人',
        '请假人员(辅助)': '夜请假、跨状态人',
        替班人员: '夜替班',
      }),
      record('night-shift-b', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'B楼',
        班组: 'C班',
        班次: '夜',
        '值班人员（实际）程序修改': '夜二',
      }),
      ...['H楼', 'D楼', 'E楼'].flatMap((building) => [
        record(`white-coverage-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: 'A班',
          班次: '白',
          请假人员: `白班覆盖-${building}`,
          '请假人员(辅助)': `白班覆盖-${building}`,
        }),
        record(`night-coverage-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: 'B班',
          班次: '夜',
          请假人员: `夜班覆盖-${building}`,
          '请假人员(辅助)': `夜班覆盖-${building}`,
        }),
      ]),
      record('night-coverage-c', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'C楼',
        班组: 'B班',
        班次: '夜',
        请假人员: '夜班覆盖-C楼',
        '请假人员(辅助)': '夜班覆盖-C楼',
      }),
    ];
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID') return personnelRows;
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      return rows;
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();
    const details = result.details.onDutyPeople as unknown as {
      scope: string;
      total: number;
      whiteShiftTotal: number;
      nightShiftTotal: number;
      shifts: {
        white: {
          total: number;
          buildings: Array<{
            building: string;
            staff: string[];
            people: Array<{
              name: string;
              status: string;
              onDuty: boolean;
              relatedStaff: string[];
            }>;
          }>;
        };
        night: {
          total: number;
          buildings: Array<{ building: string; staff: string[] }>;
        };
      };
    };

    expect(result.metrics.onDutyPeople.value).toBe(7);
    expect(details).toMatchObject({
      scope: 'daily_shifts',
      total: 7,
      whiteShiftTotal: 7,
      nightShiftTotal: 4,
    });
    expect(details.shifts.white.total).toBe(7);
    expect(details.shifts.night.total).toBe(4);
    const nightStaff = details.shifts.night.buildings.flatMap(
      (building) => building.staff,
    );
    expect(nightStaff).toContain('跨班重复');
    expect(nightStaff).not.toContain('跨状态人');
    const whitePeople = details.shifts.white.buildings.flatMap(
      (building) => building.people,
    );
    expect(whitePeople).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '请假甲',
          status: 'leave',
          onDuty: false,
          relatedStaff: ['替班甲'],
        }),
        expect.objectContaining({
          name: '调休甲',
          status: 'time_off',
          onDuty: false,
          relatedStaff: ['替班甲'],
        }),
        expect.objectContaining({
          name: '替班甲',
          status: 'substitute',
          onDuty: true,
          relatedStaff: ['请假甲', '调休甲'],
        }),
        expect.objectContaining({
          name: '补位甲',
          status: 'vacancy_substitute',
          onDuty: true,
        }),
        expect.objectContaining({
          name: '差旅甲',
          status: 'travel',
          onDuty: false,
        }),
      ]),
    );
    const nightPeople = details.shifts.night.buildings.flatMap((building) =>
      'people' in building
        ? (building as { people: Array<{ name: string; status: string }> })
            .people
        : [],
    );
    expect(nightPeople).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '跨班重复', status: 'on_duty' }),
        expect.objectContaining({ name: '跨状态人', status: 'leave' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('1001');
    expect(JSON.stringify(result)).not.toContain('13800009626');
  });

  it('does not expose pending leave or substitute staff in on-duty details', async () => {
    const personnelRows = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼'].flatMap(
      (building, index) => [
        record(`pending-white-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: '长白',
          班次: '白班',
          '人员（文本）':
            building === 'A楼' ? '待审批请假人 同班人员' : `白班人员${index}`,
          '值班人员（实际）程序修改':
            building === 'A楼' ? '待审批替班人 同班人员' : `白班人员${index}`,
          ...(building === 'A楼'
            ? {
                请假人员: '待审批请假人',
                替班人员: '待审批替班人',
                '请假人员(辅助)': '',
              }
            : {}),
        }),
        record(`pending-night-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: 'B班',
          班次: '夜班',
          '值班人员（实际）程序修改': `夜班人员${index}`,
        }),
      ],
    );
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID') return personnelRows;
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      return rows;
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();
    const serialized = JSON.stringify(result.details.onDutyPeople);
    const people = result.details.onDutyPeople.shifts.white.buildings.flatMap(
      (building) => building.people,
    );

    expect(serialized).not.toContain('待审批替班人');
    expect(people).toContainEqual(
      expect.objectContaining({
        name: '待审批请假人',
        status: 'on_duty',
        onDuty: true,
      }),
    );
  });

  it('falls back to the full personnel table when the configured view misses today buildings', async () => {
    const personnelViewRows = [
      record('view-today-long-white-a', {
        排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
        机楼: 'A楼',
        班组: '长白',
        班次: '白班',
        '值班人员（实际）程序修改': '甲',
      }),
    ];
    const fullTableRows = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼'].flatMap(
      (building, index) => [
        record(`full-today-white-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: '长白',
          班次: index === 0 ? '' : '白班',
          '值班人员（实际）程序修改': `白班人员${index + 1}`,
        }),
        record(`full-today-night-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: 'B班',
          班次: '夜班',
          '值班人员（实际）程序修改': `夜班人员${index + 1}`,
        }),
      ],
    );
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID') {
        return options.viewId ? personnelViewRows : fullTableRows;
      }
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      return rows;
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();

    expect(result.metrics.onDutyPeople.value).toBe(6);
    expect(result.details.onDutyPeople.buildings).toHaveLength(6);
    expect(result.details.onDutyPeople.nightShiftTotal).toBe(6);
    expect(
      mockedFetch.mock.calls
        .filter(([, options]) => options.tableId === 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID')
        .map(([, options]) => options.viewId),
    ).toEqual(['vew6jLlGzq', undefined]);
    expect(
      mockedEnrichScheduleRecordsWithLeaveApproval,
    ).toHaveBeenNthCalledWith(
      1,
      personnelViewRows,
      expect.objectContaining({ verified: true }),
    );
    expect(
      mockedEnrichScheduleRecordsWithLeaveApproval,
    ).toHaveBeenNthCalledWith(
      2,
      fullTableRows,
      expect.objectContaining({ verified: true }),
    );
  });

  it('fails closed when the leave approval source cannot be verified', async () => {
    const personnelRows = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼'].flatMap(
      (building, index) => [
        record(`unverified-white-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: '长白',
          班次: '白班',
          '人员（文本）':
            building === 'A楼' ? '待审批请假人 同班人员' : `白班人员${index}`,
          '值班人员（实际）程序修改':
            building === 'A楼' ? '待审批替班人 同班人员' : `白班人员${index}`,
          ...(building === 'A楼'
            ? {
                请假人员: '待审批请假人',
                '请假人员(辅助)': '待审批请假人',
                替班人员: '待审批替班人',
              }
            : {}),
        }),
        record(`unverified-night-${building}`, {
          排班日期: Date.parse('2026-07-20T00:00:00+08:00'),
          机楼: building,
          班组: 'B班',
          班次: '夜班',
          '值班人员（实际）程序修改': `夜班人员${index}`,
        }),
      ],
    );
    mockedFetchLeaveApprovalSnapshot.mockResolvedValue({
      verified: false,
      requests: [],
    });
    mockedFetch.mockImplementation(async (_httpService, options) => {
      if (options.tableId === 'PUBLIC_EXAMPLE_FEISHU_SCHEDULE_TABLE_ID') return personnelRows;
      const rows = sourceRecords[options.tableId];
      if (!rows) throw new Error(`Unexpected source ${options.tableId}`);
      return rows;
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();
    const serialized = JSON.stringify(result.details.onDutyPeople);

    expect(mockedEnrichScheduleRecordsWithLeaveApproval).toHaveBeenCalledWith(
      personnelRows,
      { verified: false, requests: [] },
    );
    expect(serialized).not.toContain('待审批替班人');
    expect(serialized).not.toContain('statusLabel":"请假');
    expect(serialized).toContain('待审批请假人');
  });

  it('does not reuse an unversioned live KPI snapshot from before approval filtering', async () => {
    const service = new TodayOperationsKpiService(httpService);
    const response = await service.getKpis();
    Object.assign(service, {
      snapshot: {
        businessDate: '2026-07-20',
        expiresAt: Date.now() + 60_000,
        retryAt: 0,
        response,
      },
    });
    mockedFetch.mockRejectedValue(new Error('Feishu unavailable'));

    await expect(service.getKpis()).rejects.toThrow();
  });

  it('does not serve a still-live memory snapshot after the Shanghai business date changes', async () => {
    jest.setSystemTime(new Date('2026-07-20T15:59:58.000Z'));
    const service = new TodayOperationsKpiService(httpService);
    const first = await service.getKpis();
    expect(first.sourceStatus).toBe('fresh');

    jest.setSystemTime(new Date('2026-07-20T16:00:03.000Z'));
    mockedFetch.mockRejectedValue(new Error('Feishu unavailable'));

    await expect(service.getKpis()).rejects.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(12);
  });

  it('does not reuse an unversioned legacy snapshot as a stale fallback', async () => {
    const service = new TodayOperationsKpiService(httpService);
    const first = await service.getKpis();
    const legacyResponse = { ...first } as Partial<typeof first>;
    delete legacyResponse.details;
    Object.assign(service, {
      snapshot: {
        businessDate: '2026-07-20',
        expiresAt: Date.now() + 60_000,
        retryAt: 0,
        response: legacyResponse,
      },
    });
    mockedFetch.mockRejectedValue(new Error('Feishu unavailable'));

    await expect(service.getKpis()).rejects.toThrow(
      '今日全景顶部指标暂时不可用，请稍后重试。',
    );
    expect(mockedFetch).toHaveBeenCalledTimes(12);
  });

  it('rejects persisted KPI snapshots fetched on a previous Shanghai business date', async () => {
    jest.setSystemTime(new Date('2026-07-20T16:00:03.000Z'));
    mockedFetch.mockRejectedValue(new Error('Feishu unavailable'));
    mockedPersistedSnapshot.mockImplementation(async (options) => {
      const rows = sourceRecords[options.tableId];
      return rows
        ? {
            records: rows,
            fetchedAt: Date.parse('2026-07-20T15:59:58.000Z'),
            expiresAt: Date.parse('2026-07-20T16:04:58.000Z'),
          }
        : null;
    });
    const service = new TodayOperationsKpiService(httpService);

    await expect(service.getKpis()).rejects.toThrow();
  });

  it('falls back to matching persisted snapshots with the same on-duty details', async () => {
    mockedFetch.mockRejectedValue(new Error('Feishu unavailable'));
    mockedPersistedSnapshot.mockImplementation(async (options) => {
      const rows = sourceRecords[options.tableId];
      return rows
        ? {
            records: rows,
            fetchedAt: Date.parse('2026-07-20T03:55:00.000Z'),
            expiresAt: Date.parse('2026-07-20T04:00:00.000Z'),
          }
        : null;
    });
    const service = new TodayOperationsKpiService(httpService);

    const result = await service.getKpis();

    expect(result.sourceStatus).toBe('stale');
    expect(result.syncedAt).toBe('2026-07-20T03:55:00.000Z');
    expect(result.metrics.onDutyPeople.value).toBe(8);
    expect(result.details.onDutyPeople).toMatchObject({
      scope: 'daily_shifts',
      date: '2026-07-20',
      total: 8,
      whiteShiftTotal: 8,
      nightShiftTotal: 1,
    });
    expect(
      result.details.onDutyPeople.shifts.white.buildings.flatMap(
        (building) => building.staff,
      ),
    ).toEqual(
      expect.arrayContaining([
        '周九',
        '重复人',
        '替班甲',
        '缺岗甲',
        '替班乙',
        '缺岗乙',
        '孙七',
        '倒班人员',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('1001');
    expect(JSON.stringify(result)).not.toContain('13800009626');
    expect(mockedPersistedSnapshot).toHaveBeenCalledTimes(6);
  });
});
