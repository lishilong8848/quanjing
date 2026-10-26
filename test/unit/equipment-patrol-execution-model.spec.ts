import type {
  EquipmentPatrolExecutionRecord,
  EquipmentPatrolExecutionResponse,
} from '../../shared/equipment-patrol-execution.interface';

jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

const loadModel = () =>
  require('../../client/src/pages/EquipmentPatrolDashboard/execution-model');
const {
  getPatrolMonthDashboard,
} = require('../../client/src/pages/EquipmentPatrolDashboard/model');

function execution(
  overrides: Partial<EquipmentPatrolExecutionRecord>,
): EquipmentPatrolExecutionRecord {
  return {
    recordId: 'record',
    title: '设备轮巡',
    building: 'A楼',
    buildingSource: 'field',
    equipment: '制冷单元',
    specialty: '暖通专业',
    categories: ['制冷单元'],
    planStart: '2026-07-10T08:00:00+08:00',
    planEnd: '2026-07-10T09:00:00+08:00',
    actualStart: null,
    actualEnd: null,
    progress: '',
    status: '未知',
    content: '',
    updatedAt: '2026-07-10T08:00:00+08:00',
    nonPlanned: false,
    qualityFlags: [],
    ...overrides,
  };
}

function julyResponse(): EquipmentPatrolExecutionResponse {
  return {
    month: '2026-07',
    generatedAt: '2026-07-15T12:00:00+08:00',
    sourceUpdatedAt: '2026-07-15T10:30:00+08:00',
    sourceUrl: 'https://example.test/equipment-patrol',
    sourceMode: 'live',
    stale: false,
    totalSourceRecords: 7,
    warnings: [],
    records: [
      execution({
        recordId: 'a-start',
        status: '开始',
        actualStart: '2026-07-10T08:10:00+08:00',
      }),
      execution({
        recordId: 'a-update',
        status: '更新',
        actualStart: '2026-07-10T08:10:00+08:00',
        updatedAt: '2026-07-10T08:40:00+08:00',
      }),
      execution({
        recordId: 'a-end',
        status: '结束',
        actualStart: '2026-07-10T08:10:00+08:00',
        actualEnd: '2026-07-10T10:00:00+08:00',
        updatedAt: '2026-07-10T10:00:00+08:00',
      }),
      execution({
        recordId: 'd-start',
        building: 'D楼',
        status: '开始',
        actualStart: '2026-07-10T08:05:00+08:00',
      }),
      execution({
        recordId: 'c-outside',
        building: 'C楼',
        planStart: '2026-07-09T08:00:00+08:00',
        planEnd: '2026-07-09T09:00:00+08:00',
        actualStart: '2026-07-09T09:00:00+08:00',
        actualEnd: '2026-07-09T09:30:00+08:00',
        status: '结束',
        updatedAt: '2026-07-09T09:30:00+08:00',
      }),
      execution({
        recordId: 'e-outside',
        building: 'E楼',
        equipment: '水质循环',
        categories: ['水质循环'],
        planStart: '2026-07-04T08:00:00+08:00',
        planEnd: '2026-07-04T09:00:00+08:00',
        actualStart: '2026-07-04T08:00:00+08:00',
        actualEnd: '2026-07-04T09:00:00+08:00',
        status: '结束',
        qualityFlags: ['actual_time_drift'],
        updatedAt: '2026-07-04T09:00:00+08:00',
      }),
      execution({
        recordId: 'missing-building',
        building: null,
        buildingSource: 'missing',
        status: '开始',
        actualStart: '2026-07-10T08:00:00+08:00',
        qualityFlags: ['building_missing'],
      }),
    ],
  };
}

describe('equipment patrol execution view model', () => {
  test('merges same-building day and category records with completed data winning', () => {
    const dashboard = getPatrolMonthDashboard('2026-07');
    const view = loadModel().buildEquipmentPatrolExecutionView(
      dashboard,
      julyResponse(),
    );
    const refrigeration = view.buildingDevices['A楼'].find(
      (device: { id: string }) => device.id === 'refrigeration-unit',
    );

    expect(refrigeration).toMatchObject({
      executed: 1,
      partial: 0,
      missed: 0,
    });
    expect(refrigeration.days[9].status).toBe('completed');
    expect(
      view.buildings.find(
        (building: { building: string }) => building.building === 'A楼',
      ),
    ).toMatchObject({
      covered: 1,
      active: 0,
    });
    expect(
      view.anomalies.filter((item: { recordIds: string[] }) =>
        item.recordIds.includes('a-end'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'end_overtime', priority: 6 }),
      ]),
    );
  });

  test('computes July plan coverage and prioritized deviations for A-E', () => {
    const dashboard = getPatrolMonthDashboard('2026-07');
    const view = loadModel().buildEquipmentPatrolExecutionView(
      dashboard,
      julyResponse(),
    );

    expect(view.kpis).toMatchObject({
      monthPlanPerBuilding: 9,
      due: 15,
      covered: 2,
      compliantBuildings: 0,
    });
    expect(view.buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          building: 'A楼',
          monthPlan: 9,
          due: 3,
          covered: 1,
          overdue: 2,
          active: 0,
          future: 6,
          outOfPlan: 0,
          coverageRate: 33.3,
        }),
        expect.objectContaining({
          building: 'B楼',
          monthPlan: 9,
          due: 3,
          covered: 0,
          overdue: 3,
          active: 0,
          future: 6,
          outOfPlan: 0,
          coverageRate: 0,
        }),
        expect.objectContaining({
          building: 'C楼',
          monthPlan: 9,
          due: 3,
          covered: 0,
          overdue: 3,
          active: 0,
          future: 6,
          outOfPlan: 1,
          coverageRate: 0,
        }),
        expect.objectContaining({
          building: 'D楼',
          monthPlan: 9,
          due: 3,
          covered: 1,
          overdue: 2,
          active: 1,
          future: 6,
          outOfPlan: 0,
          coverageRate: 33.3,
        }),
        expect.objectContaining({
          building: 'E楼',
          monthPlan: 9,
          due: 3,
          covered: 0,
          overdue: 3,
          active: 0,
          future: 6,
          outOfPlan: 1,
          coverageRate: 0,
        }),
      ]),
    );
    expect(view.anomalies[0]).toMatchObject({
      type: 'time_quality',
      building: 'E楼',
      priority: 1,
    });
    expect(
      view.anomalies.some(
        (item: { type: string; deviceId: string }) =>
          item.type === 'overdue_uncovered' &&
          item.deviceId === 'water-quality-circulation',
      ),
    ).toBe(true);
    expect(
      view.anomalies.find(
        (item: { type: string }) => item.type === 'unfinished',
      ),
    ).toMatchObject({ building: 'D楼', priority: 3 });
    expect(
      view.anomalies.filter(
        (item: { type: string }) => item.type === 'outside_plan_window',
      ),
    ).toHaveLength(3);
    expect(view.kpis.deviations).toBe(view.anomalies.length);
  });

  test('decorates each building matrix while preserving planned future cells', () => {
    const view = loadModel().buildEquipmentPatrolExecutionView(
      getPatrolMonthDashboard('2026-07'),
      julyResponse(),
    );
    const byBuilding = (building: string, deviceId: string) =>
      view.buildingDevices[building].find(
        (device: { id: string }) => device.id === deviceId,
      );

    expect(byBuilding('D楼', 'refrigeration-unit').days[9].status).toBe(
      'partial',
    );
    expect(byBuilding('B楼', 'refrigeration-unit').days[9].status).toBe(
      'missed',
    );
    expect(byBuilding('A楼', 'water-quality-circulation').days[2].status).toBe(
      'missed',
    );
    expect(byBuilding('A楼', 'water-quality-circulation').days[16].status).toBe(
      'planned',
    );
  });

  test('uses source cutoff by month and falls back to dashboard reference date', () => {
    const build = loadModel().buildEquipmentPatrolExecutionView;
    const july = getPatrolMonthDashboard('2026-07');
    const response = julyResponse();

    expect(build(july, response).sourceStatus.referenceDate).toBe('2026-07-15');
    expect(
      build(getPatrolMonthDashboard('2026-06'), response).sourceStatus
        .referenceDate,
    ).toBe('2026-06-30');
    expect(build(getPatrolMonthDashboard('2026-08'), response).kpis.due).toBe(
      0,
    );

    response.sourceUpdatedAt = null;
    expect(build(july, response).sourceStatus.referenceDate).toBe(
      july.referenceDate,
    );
  });

  test('returns deeply independent data without mutating dashboard or response', () => {
    const dashboard = getPatrolMonthDashboard('2026-07');
    const response = julyResponse();
    const dashboardBefore = JSON.parse(JSON.stringify(dashboard));
    const responseBefore = JSON.parse(JSON.stringify(response));
    const view = loadModel().buildEquipmentPatrolExecutionView(
      dashboard,
      response,
    );

    view.buildingDevices['A楼'][0].days[0].status = 'missed';
    view.sourceStatus.warnings.push('view-only');

    expect(dashboard).toEqual(dashboardBefore);
    expect(response).toEqual(responseBefore);
    expect(view.buildingDevices['A楼']).not.toBe(dashboard.devices);
    expect(view.sourceStatus.warnings).not.toBe(response.warnings);
  });
});

describe('equipment patrol execution api', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requests the selected month and explicit refresh flag', async () => {
    const response = julyResponse();
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: response });
    const { getEquipmentPatrolExecutions } = require('../../client/src/api');

    await expect(getEquipmentPatrolExecutions('2026-07', true)).resolves.toBe(
      response,
    );
    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/equipment-patrol/executions',
      method: 'GET',
      params: { month: '2026-07', refresh: '1' },
      timeout: 120_000,
    });
  });
});
