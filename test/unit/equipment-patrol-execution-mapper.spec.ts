import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';
import type { HttpService } from '@nestjs/axios';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import {
  filterEquipmentPatrolExecutionRecordsByMonth,
  mapEquipmentPatrolExecutionRecord,
  mapEquipmentPatrolExecutionRecords,
} from '../../server/modules/equipment-patrol/equipment-patrol-execution.mapper';
import { EquipmentPatrolExecutionService } from '../../server/modules/equipment-patrol/equipment-patrol-execution.service';

jest.mock('../../server/common/feishu/bitable-direct-read', () => {
  return {
    fetchBitableRecords: jest.fn(),
    resolveBitableAppToken: jest.fn(),
  };
});

function rawRecord(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

describe('equipment patrol execution mapper', () => {
  test('normalizes building values, statuses, field shapes, and dates', () => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord('rec-normalized', {
        '标题（名称）': 'A栋制冷单元轮巡',
        楼栋: ['A栋'],
        设备: 'A-127制冷单元',
        专业: ['暖通'],
        计划开始时间: '2026-07-10 09:30:00',
        计划结束时间: '2026-07-10 18:30:00',
        实际开始时间: '2026-07-10 09:20:00',
        实际结束时间: '2026-07-10 17:40:00',
        进度: '已完成',
        轮巡状态: ['结束'],
        内容: '设备运行正常',
        最后更新时间: '2026-07-10 17:45:05',
      }),
    );

    expect(record).toMatchObject({
      recordId: 'rec-normalized',
      building: 'A楼',
      buildingSource: 'field',
      specialty: '暖通',
      categories: ['制冷单元'],
      status: '结束',
      planStart: '2026-07-10T01:30:00.000Z',
      actualEnd: '2026-07-10T09:40:00.000Z',
      updatedAt: '2026-07-10T09:45:05.000Z',
      nonPlanned: false,
      qualityFlags: [],
    });
  });

  test('infers a missing building from the title and marks the source', () => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord('rec-inferred', {
        '标题（名称）': 'EA118机房B栋风冷空调轮巡通告',
        设备: '英维克风冷空调',
      }),
    );

    expect(record.building).toBe('B楼');
    expect(record.buildingSource).toBe('title');
    expect(record.qualityFlags).toContain('building_inferred');
  });

  test('marks a building as missing when neither field nor title identifies one', () => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord('rec-building-missing', {
        '标题（名称）': '设备轮巡通告',
        设备: '未知设备',
      }),
    );

    expect(record.building).toBeNull();
    expect(record.buildingSource).toBe('missing');
    expect(record.qualityFlags).toContain('building_missing');
  });

  test.each([
    ['制冷单元轮巡', ['制冷单元']],
    ['精密空调与风冷空调轮巡', ['辅助区域精密空调']],
    ['二次泵轮巡', ['二次泵']],
    ['东西区变频补水机组轮巡', ['东西区变频补水机组']],
    ['补水泵轮巡', ['东西区变频补水机组']],
    ['包间空调备机轮巡', ['包间空调（备机）']],
    ['包间轮巡', ['包间空调（备机）']],
    ['水质循环轮巡', ['水质循环']],
    ['屋面冷塔轮巡', ['其他']],
    ['制冷单元及二次泵联合轮巡', ['制冷单元', '二次泵']],
  ])('classifies %s', (equipment, expectedCategories) => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord(`rec-${equipment}`, { 设备: equipment }),
    );

    expect(record.categories).toEqual(expectedCategories);
  });

  test.each([
    [['开始'], '开始'],
    ['更新', '更新'],
    [['结束'], '结束'],
    ['待处理', '未知'],
  ])('normalizes status %p as %s', (rawStatus, expectedStatus) => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord(`rec-${expectedStatus}`, { 轮巡状态: rawStatus }),
    );

    expect(record.status).toBe(expectedStatus);
  });

  test('marks inverted and invalid time ranges, drift, and non-planned work', () => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord('rec-quality', {
        '标题（名称）': 'D楼制冷单元轮巡（非计划性）',
        楼栋: 'D楼',
        计划开始时间: '2026-07-05 18:00:00',
        计划结束时间: '2026-07-05 09:00:00',
        实际开始时间: '2026-07-08 09:00:00',
        实际结束时间: 'not-a-date',
      }),
    );

    expect(record.nonPlanned).toBe(true);
    expect(record.actualEnd).toBeNull();
    expect(record.qualityFlags).toEqual([
      'plan_time_invalid',
      'actual_time_invalid',
      'actual_time_drift',
    ]);
  });

  test('does not mark an unfinished actual range as invalid', () => {
    const record = mapEquipmentPatrolExecutionRecord(
      rawRecord('rec-in-progress', {
        计划开始时间: '2026-07-10 09:00:00',
        计划结束时间: '2026-07-10 18:00:00',
        实际开始时间: '2026-07-10 09:05:00',
        轮巡状态: ['开始'],
      }),
    );

    expect(record.actualEnd).toBeNull();
    expect(record.qualityFlags).not.toContain('actual_time_invalid');
  });

  test('filters by plan start, then actual start, then updated time', () => {
    const records = mapEquipmentPatrolExecutionRecords([
      rawRecord('rec-plan-july', {
        计划开始时间: '2026-07-31 23:00:00',
        实际开始时间: '2026-06-30 09:00:00',
      }),
      rawRecord('rec-actual-july', {
        实际开始时间: '2026-07-01 09:00:00',
      }),
      rawRecord('rec-updated-july', {
        最后更新时间: '2026-07-15 12:00:00',
      }),
      rawRecord('rec-august', {
        计划开始时间: '2026-08-01 00:00:00',
      }),
    ]);

    expect(
      filterEquipmentPatrolExecutionRecordsByMonth(records, '2026-07').map(
        (record) => record.recordId,
      ),
    ).toEqual(['rec-plan-july', 'rec-actual-july', 'rec-updated-july']);
  });
});

describe('equipment patrol execution service', () => {
  const sourceUrl =
    'https://vnet.feishu.cn/wiki/D01TwFPyXiJBY6kCBDZcMCGLnSe?table=tbl0XK1iQ1P6VY5Y&view=vewcI3Ssfv';
  const mockedFetch = jest.mocked(fetchBitableRecords);
  const mockedResolve = jest.mocked(resolveBitableAppToken);
  const httpService = {} as HttpService;
  let originalSourceUrl: string | undefined;

  beforeEach(() => {
    originalSourceUrl =
      process.env.FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL;
    process.env.FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL = sourceUrl;
    jest.clearAllMocks();
    mockedResolve.mockResolvedValue('resolved-app-token');
  });

  afterEach(() => {
    if (originalSourceUrl === undefined) {
      delete process.env.FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL;
    } else {
      process.env.FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL =
        originalSourceUrl;
    }
  });

  test('returns live records filtered by month while retaining the source total', async () => {
    mockedFetch.mockResolvedValue([
      rawRecord('rec-july', {
        '标题（名称）': 'A楼制冷单元轮巡',
        计划开始时间: '2026-07-10 09:00:00',
      }),
      rawRecord('rec-august', {
        '标题（名称）': 'B楼二次泵轮巡',
        计划开始时间: '2026-08-10 09:00:00',
      }),
    ]);

    const service = new EquipmentPatrolExecutionService(httpService);
    const response = await service.getExecutions({
      month: '2026-07',
      refresh: '1',
    });

    expect(response).toMatchObject({
      month: '2026-07',
      sourceUrl,
      sourceMode: 'live',
      stale: false,
      totalSourceRecords: 2,
      warnings: [],
    });
    expect(response.records.map((record) => record.recordId)).toEqual([
      'rec-july',
    ]);
    expect(mockedResolve).toHaveBeenCalledWith(httpService, {
      appToken: '',
      wikiToken: 'D01TwFPyXiJBY6kCBDZcMCGLnSe',
      tableName: '设备轮巡执行数据',
    });
    expect(mockedFetch).toHaveBeenCalledWith(httpService, {
      appToken: 'resolved-app-token',
      tableId: 'tbl0XK1iQ1P6VY5Y',
      tableName: '设备轮巡执行数据',
      forceRefresh: true,
    });
  });

  test('falls back to the raw-record snapshot without exposing the live error', async () => {
    mockedFetch.mockRejectedValue(
      new Error('request failed with tenant_access_token=secret-value'),
    );

    const service = new EquipmentPatrolExecutionService(httpService);
    const response = await service.getExecutions({
      month: '2026-07',
      refresh: '0',
    });

    expect(response.sourceMode).toBe('snapshot');
    expect(response.stale).toBe(true);
    expect(response.totalSourceRecords).toBe(128);
    expect(response.records.length).toBeGreaterThan(0);
    expect(response.warnings).toHaveLength(1);
    expect(response.warnings.join(' ')).not.toContain('secret-value');
  });
});
