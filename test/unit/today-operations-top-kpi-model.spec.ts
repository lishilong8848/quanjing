import {
  buildOnDutyDialogModel,
  buildTopKpiPlaceholders,
  buildTopKpis,
  resolveShanghaiOnDutyLeadShift,
} from '../../client/src/pages/TodayOperationsPanorama/top-kpi-model';
import type { TodayOperationsKpiResponse } from '../../shared/today-operations-kpi.interface';

const metrics = {
  safeOperationDays: {
    value: 3000,
    previousValue: 2999,
    date: '2026-07-20',
  },
  onDutyPeople: {
    value: 28,
    previousValue: 30,
    date: '2026-07-20',
  },
  averagePue: {
    value: 1.245,
    previousValue: 1.268,
    date: '2026-07-20',
  },
  itLoadRate: {
    value: 51.04,
    previousValue: 49.9,
    date: '2026-07-20',
  },
  electricityKwh: {
    value: 1026221,
    previousValue: 1027000,
    date: '2026-07-20',
  },
  waterTons: {
    value: 1548.7,
    previousValue: 1805.4,
    date: '2026-07-20',
  },
};

describe('today operations top KPI model', () => {
  it('formats every live metric and exposes deterministic rise/fall comparisons', () => {
    const cards = buildTopKpis(metrics);

    expect(cards).toHaveLength(6);
    expect(cards.map((card) => card.key)).toEqual([
      'running-days',
      'on-duty',
      'average-pue',
      'it-load',
      'electricity',
      'water',
    ]);
    expect(
      cards.map(({ value, unit, comparison, direction }) => ({
        value,
        unit,
        comparison,
        direction,
      })),
    ).toEqual([
      {
        value: '3,000',
        unit: '天',
        comparison: '较昨日 ↑ 1',
        direction: 'up',
      },
      {
        value: '28',
        unit: '人',
        comparison: '较昨日 ↓ 2',
        direction: 'down',
      },
      {
        value: '1.245',
        unit: '',
        comparison: '较昨日 ↓ 0.023',
        direction: 'down',
      },
      {
        value: '51.0',
        unit: '%',
        comparison: '较昨日 ↑ 1.1%',
        direction: 'up',
      },
      {
        value: '1,026,221',
        unit: 'KWh',
        comparison: '较昨日 ↓ 779 KWh',
        direction: 'down',
      },
      {
        value: '1,548.7',
        unit: 't',
        comparison: '较昨日 ↓ 256.7 t',
        direction: 'down',
      },
    ]);
  });

  it('uses a neutral dated caption when a source has no previous value', () => {
    const cards = buildTopKpis({
      ...metrics,
      averagePue: {
        value: 1.25,
        previousValue: null,
        date: '2026-07-20',
      },
    });

    expect(cards[2]).toMatchObject({
      value: '1.250',
      comparison: '截至 07-20',
      direction: 'neutral',
    });
  });

  it('uses the on-duty detail total so the card and dialog list stay in sync', () => {
    const cards = buildTopKpis(
      {
        ...metrics,
        onDutyPeople: {
          value: 91,
          previousValue: null,
          date: '2026-07-20',
        },
      },
      {
        onDutyPeople: {
          scope: 'long_white',
          date: '2026-07-20',
          total: 3,
          buildings: [
            {
              building: 'A',
              buildingName: 'A楼',
              staff: ['示例人员008', '示例人员013'],
            },
            {
              building: 'B',
              buildingName: 'B楼',
              staff: ['示例人员017'],
            },
          ],
        },
      },
    );

    expect(cards.find((card) => card.key === 'on-duty')).toMatchObject({
      value: '3',
      comparison: '截至 07-20',
    });
  });

  it('shows white-shift count on the card and normalizes white/night rosters for the dialog', () => {
    const response = {
      sourceStatus: 'fresh',
      syncedAt: '2026-07-20T16:00:00.000Z',
      metrics: {
        ...metrics,
        onDutyPeople: {
          value: 2,
          previousValue: null,
          date: '2026-07-20',
        },
      },
      details: {
        onDutyPeople: {
          scope: 'daily_shifts',
          date: '2026-07-20',
          total: 2,
          whiteShiftTotal: 2,
          nightShiftTotal: 1,
          buildings: [],
          shifts: {
            white: {
              shift: 'white',
              shiftLabel: '白班',
              total: 2,
              buildings: [
                {
                  building: 'A',
                  buildingName: 'A楼',
                  staff: ['示例人员008', '替班王'],
                  people: [
                    {
                      name: '示例人员008',
                      status: 'on_duty',
                      statusLabel: '在岗',
                      onDuty: true,
                      relatedStaff: [],
                    },
                    {
                      name: '示例人员013',
                      status: 'leave',
                      statusLabel: '请假',
                      onDuty: false,
                      relatedStaff: [],
                    },
                    {
                      name: '替班王',
                      status: 'substitute',
                      statusLabel: '替班',
                      onDuty: true,
                      relatedStaff: ['示例人员013'],
                    },
                  ],
                },
              ],
            },
            night: {
              shift: 'night',
              shiftLabel: '夜班',
              total: 1,
              buildings: [
                {
                  building: 'B',
                  buildingName: 'B楼',
                  staff: ['示例人员017'],
                  people: [
                    {
                      name: '示例人员017',
                      status: 'time_off',
                      statusLabel: '调休',
                      onDuty: false,
                      relatedStaff: [],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    } as unknown as TodayOperationsKpiResponse;

    expect(
      buildTopKpis(response.metrics, response.details, 'white')[1],
    ).toMatchObject({
      key: 'on-duty',
      value: '2',
      comparison: '白班 2人 · 夜班 1人',
      direction: 'neutral',
    });
    expect(buildOnDutyDialogModel(response, 'white')).toMatchObject({
      total: 2,
      whiteShiftTotal: 2,
      nightShiftTotal: 1,
      isSummaryOnly: false,
      shifts: [
        {
          shift: 'white',
          shiftLabel: '白班',
          total: 2,
          dataAvailable: true,
          buildings: [
            {
              buildingName: 'A楼',
              people: [
                { name: '示例人员008', statusLabel: '在岗', onDuty: true },
                { name: '示例人员013', statusLabel: '请假', onDuty: false },
                {
                  name: '替班王',
                  statusLabel: '替班',
                  relatedStaff: ['示例人员013'],
                },
              ],
            },
          ],
        },
        {
          shift: 'night',
          shiftLabel: '夜班',
          total: 1,
          dataAvailable: true,
        },
      ],
    });
    const nightCard = buildTopKpis(
      response.metrics,
      response.details,
      'night',
    )[1];
    const nightDialog = buildOnDutyDialogModel(response, 'night');

    expect(nightCard).toMatchObject({
      key: 'on-duty',
      value: '1',
      comparison: '夜班 1人 · 白班 2人',
      direction: 'neutral',
    });
    expect(nightDialog).toMatchObject({
      total: 1,
      shifts: [{ shift: 'night' }, { shift: 'white' }],
    });
    expect(nightCard.value).toBe(String(nightDialog.shifts[0]?.total));
  });

  it.each([
    ['2026-07-20T00:59:59.999Z', 'night'],
    ['2026-07-20T01:00:00.000Z', 'white'],
    ['2026-07-20T09:59:59.999Z', 'white'],
    ['2026-07-20T10:00:00.000Z', 'night'],
    ['2026-07-20T16:00:00.000Z', 'night'],
    ['2026-07-21T00:59:59.999Z', 'night'],
    ['2026-07-21T01:00:00.000Z', 'white'],
  ] as const)(
    'uses the Shanghai 09:00 and 18:00 boundaries for %s',
    (timestamp, expected) => {
      expect(resolveShanghaiOnDutyLeadShift(new Date(timestamp))).toBe(
        expected,
      );
    },
  );

  it('keeps a legacy KPI payload without details renderable as summary-only data', () => {
    const legacyResponse = {
      sourceStatus: 'stale',
      syncedAt: '2026-07-20T15:00:00.000Z',
      metrics: {
        ...metrics,
        onDutyPeople: {
          value: 91,
          previousValue: null,
          date: '2026-07-20',
        },
      },
    } as TodayOperationsKpiResponse;

    expect(buildOnDutyDialogModel(legacyResponse)).toEqual({
      total: 91,
      whiteShiftTotal: 91,
      nightShiftTotal: null,
      date: '2026-07-20',
      isSummaryOnly: true,
      shifts: [
        {
          shift: 'white',
          shiftLabel: '白班',
          total: 91,
          dataAvailable: false,
          buildings: [],
        },
        {
          shift: 'night',
          shiftLabel: '夜班',
          total: null,
          dataAvailable: false,
          buildings: [],
        },
      ],
    });
    expect(() =>
      buildTopKpis(legacyResponse.metrics, legacyResponse.details),
    ).not.toThrow();
  });

  it('renders explicit loading and error placeholders instead of sample values', () => {
    const loading = buildTopKpiPlaceholders('loading');
    const error = buildTopKpiPlaceholders('error');

    expect(loading).toHaveLength(6);
    expect(loading.every((card) => card.value === '--')).toBe(true);
    expect(loading.every((card) => card.comparison === '正在读取')).toBe(true);
    expect(error.every((card) => card.value === '--')).toBe(true);
    expect(error.every((card) => card.comparison === '数据暂不可用')).toBe(
      true,
    );
  });
});
