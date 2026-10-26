import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import {
  createCampusOperationsInitialViewState,
  hasExactCampusOperationsScreenshotData,
} from '../../client/src/pages/CampusOperationsDashboard';
import { resolvePreviousCampusOperationsShift } from '../../shared/campus-operations-shift';

jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('@server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
}));

jest.mock('../../client/src/api', () => ({
  checkMonthlyScheduleScreenshotAccess: jest.fn(),
  getCampusOperationsDashboard: jest.fn(),
}));

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function createTransformerRecords(date: string, shift: string) {
  return ['1号主变', '2号主变', '3号主变', '4号主变'].map((name) => ({
    fields: {
      日期: date,
      班次: shift,
      主变名称: name,
      所属线路: '测试线路',
      油温: 45,
      档位: 3,
      '负载（KW）': 1000,
      '电流（A）': 100,
      '负载率%': 20,
      GIS压力是否正常: '正常',
    },
  }));
}

function createMachineRecords(date: string, shift: string) {
  return ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((building) => ({
    fields: {
      日期: date,
      班次: shift,
      楼栋: building,
      '总负荷（kW）': 2000,
      'IT总负荷（kW）': 1500,
      'IT设计总负荷（kW）': 3000,
      'PUE（实时）': 1.3,
      IT负载率: 50,
    },
  }));
}

describe('campus operations screenshot access', () => {
  beforeEach(() => {
    jest.mocked(fetchBitableRecords).mockReset();
  });

  it('starts screenshot mode in a non-ready state without fallback dashboard data', () => {
    expect(createCampusOperationsInitialViewState(true)).toEqual({
      syncStatus: 'syncing',
      hasExactScreenshotData: false,
      dashboardData: {
        transformerRows: [],
        buildingMetrics: [],
      },
    });
  });

  it('does not accept a successful screenshot response sourced from another shift', () => {
    const response = {
      transformerRows: ['1号主变', '2号主变', '3号主变', '4号主变'].map(
        (name) => ({ name }),
      ),
      buildingMetrics: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map(
        (building) => ({ building }),
      ),
      target: {
        requestedDate: '2026-07-21',
        requestedShift: '白班',
        transformerDate: '2026-07-21',
        transformerShift: '白班',
        machineDate: '2026-07-21',
        machineShift: '白班',
        rule: 'test',
      },
      fetchedAt: '2026-07-22T00:00:00.000Z',
    };

    expect(
      hasExactCampusOperationsScreenshotData(response as never, {
        screenshotDate: '2026-07-22',
        screenshotShift: 'white',
        screenshotToken: 'token',
      }),
    ).toBe(false);
  });

  it('accepts the complete previous-night response for a white-shift report screenshot', () => {
    const response = {
      transformerRows: ['1号主变', '2号主变', '3号主变', '4号主变'].map(
        (name) => ({ name }),
      ),
      buildingMetrics: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map(
        (building) => ({ building }),
      ),
      target: {
        requestedDate: '2026-07-21',
        requestedShift: '夜班',
        transformerDate: '2026-07-21',
        transformerShift: '夜班',
        machineDate: '2026-07-21',
        machineShift: '夜班',
        rule: 'test',
      },
      fetchedAt: '2026-07-22T00:00:00.000Z',
    };

    expect(
      hasExactCampusOperationsScreenshotData(response as never, {
        screenshotDate: '2026-07-22',
        screenshotShift: 'white',
        screenshotToken: 'token',
      }),
    ).toBe(true);
  });

  it('verifies the signed screenshot request before mounting dashboard data loads', () => {
    const pageSource = readSource(
      'client/src/pages/CampusOperationsDashboard/index.tsx',
    );
    const routeGuardSource = readSource(
      'client/src/access/RouteAccessGuard.tsx',
    );

    expect(routeGuardSource).toContain(
      'isControlledScreenshotPageRequest(location.pathname, location.search)',
    );
    expect(pageSource).toContain('checkMonthlyScheduleScreenshotAccess');
    expect(pageSource).toContain('CampusOperationsScreenshotAccessGuard');
    expect(pageSource).toContain('screenshotToken');
    expect(pageSource).toContain("audience: 'campus-operations'");
    expect(pageSource).toContain('screenshotShift: payload.screenshotShift');
    expect(pageSource).toContain('isCampusOperationsScreenshotReady(');
  });

  it('forwards the signed date and shift through the client and controller', () => {
    const apiSource = readSource('client/src/api/index.ts');
    const controllerSource = readSource(
      'server/modules/bitable-sync/bitable-sync.controller.ts',
    );

    expect(apiSource).toContain('screenshotAccess?.screenshotDate');
    expect(apiSource).toContain('screenshotAccess?.screenshotShift');
    expect(apiSource).toContain('screenshotAccess?.screenshotToken');
    expect(controllerSource).toContain(
      "@Query('screenshotDate') screenshotDate?: string",
    );
    expect(controllerSource).toContain(
      "@Query('screenshotShift') screenshotShift?: string",
    );
    expect(controllerSource).toMatch(
      /getCampusOperationsDashboard\(\s*shouldRefresh,\s*screenshotDate,\s*screenshotShift,\s*\)/,
    );
  });

  it.each([
    ['white', '2026-07-21', 'night', '夜班'],
    ['night', '2026-07-22', 'white', '白班'],
  ] as const)(
    'uses the previous shift for a signed %s report screenshot',
    (reportShift, sourceDate, sourceShift, sourceShiftLabel) => {
    const service = new BitableSyncService({} as never, {} as never);
    const internals = service as unknown as {
      getCampusOperationsTargetShift: (
        now: Date,
        requestedDate?: string,
        requestedShift?: string,
      ) => {
        requestedDate: string;
        requestedShift: string;
        rule: string;
      };
    };

    expect(
      resolvePreviousCampusOperationsShift('2026-07-22', reportShift),
    ).toEqual({
      date: sourceDate,
      shift: sourceShift,
      shiftLabel: sourceShiftLabel,
    });
    expect(
      internals.getCampusOperationsTargetShift(
        new Date('2026-07-22T02:00:00.000Z'),
        '2026-07-22',
        reportShift,
      ),
    ).toMatchObject({
      requestedDate: sourceDate,
      requestedShift: sourceShiftLabel,
    });
    },
  );

  it('resolves the previous night across a year boundary', () => {
    expect(
      resolvePreviousCampusOperationsShift('2027-01-01', 'white'),
    ).toEqual({
      date: '2026-12-31',
      shift: 'night',
      shiftLabel: '夜班',
    });
  });

  it('rejects a screenshot request when only another date and shift has complete data', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(createTransformerRecords('2026-07-21', '白班'))
      .mockResolvedValueOnce(createMachineRecords('2026-07-21', '白班'));
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCampusOperationsDashboard(
        false,
        '2026-07-22',
        'white',
      ),
    ).rejects.toThrow('2026-07-21 夜班');
  });

  it('returns only complete data from the previous shift of the report screenshot', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([
        ...createTransformerRecords('2026-07-21', '白班'),
        ...createTransformerRecords('2026-07-21', '夜班'),
      ])
      .mockResolvedValueOnce([
        ...createMachineRecords('2026-07-21', '白班'),
        ...createMachineRecords('2026-07-21', '夜班'),
      ]);
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCampusOperationsDashboard(
        false,
        '2026-07-22',
        'white',
      ),
    ).resolves.toMatchObject({
      transformerRows: expect.arrayContaining([
        expect.objectContaining({ name: '1号主变' }),
      ]),
      buildingMetrics: expect.arrayContaining([
        expect.objectContaining({ building: 'A楼' }),
      ]),
      target: {
        requestedDate: '2026-07-21',
        requestedShift: '夜班',
        transformerDate: '2026-07-21',
        transformerShift: '夜班',
        machineDate: '2026-07-21',
        machineShift: '夜班',
        rule: expect.any(String),
      },
    });
  });

  it('rejects incomplete exact screenshot data instead of filling missing rows', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce([
        ...createTransformerRecords('2026-07-19', '白班'),
        ...createTransformerRecords('2026-07-21', '夜班').slice(0, 3),
      ])
      .mockResolvedValueOnce(createMachineRecords('2026-07-21', '夜班'));
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCampusOperationsDashboard(
        false,
        '2026-07-22',
        'white',
      ),
    ).rejects.toThrow('主变缺少：4号主变');
  });

  it('reports both missing source groups when the exact shift has no records', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(createTransformerRecords('2026-07-19', '白班'))
      .mockResolvedValueOnce(createMachineRecords('2026-07-19', '白班'));
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCampusOperationsDashboard(
        false,
        '2026-07-22',
        'white',
      ),
    ).rejects.toThrow(
      '主变缺少：1号主变、2号主变、3号主变、4号主变；机房缺少：A楼、B楼、C楼、D楼、E楼',
    );
  });

  it('keeps the existing fallback selection for normal interactive requests', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockResolvedValueOnce(createTransformerRecords('2020-01-01', '白班'))
      .mockResolvedValueOnce(createMachineRecords('2020-01-01', '白班'));
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCampusOperationsDashboard(false),
    ).resolves.toMatchObject({
      target: {
        transformerDate: '2020-01-01',
        transformerShift: '白班',
        machineDate: '2020-01-01',
        machineShift: '白班',
      },
    });
  });
});
