import type {
  ChangeInfo,
  MonthlySchedule,
  SealingInfo,
} from '../../../shared/api.interface';
import type { QWeatherWarningItem } from '../bitable-sync/bitable-sync.service';
import {
  detectFacilityMetricIssues,
  detectPlanConflicts,
  detectScheduleRisks,
  detectWeatherAlerts,
  unavailablePatrolCheck,
} from './daily-operations-patrol.rules';

describe('daily operations patrol rules', () => {
  it('treats an exact 50 percent facility change as an anomaly against two prior days', () => {
    const result = detectFacilityMetricIssues({
      businessDate: '2026-09-07',
      thresholdPercent: 50,
      compareDays: 2,
      metrics: [
        {
          key: 'pue',
          label: 'PUE',
          unit: '',
          history: [
            period('2026-09-06', { A楼: 1.5, B楼: 1 }),
            period('2026-09-05', { A楼: 1, B楼: 1 }),
            period('2026-09-04', { A楼: 1, B楼: 1 }),
          ],
        },
      ],
    });

    expect(result.status).toBe('alert');
    expect(result.count).toBe(1);
    expect(result.issues[0]).toMatchObject({
      check: 'facility',
      title: 'A楼 PUE 上升 50%',
      date: '2026-09-06',
      severity: 'warning',
    });
    expect(result.issues[0].detail).toContain('前2日均值 1');
  });

  it('reports unavailable facility data instead of silently treating it as normal', () => {
    const result = detectFacilityMetricIssues({
      businessDate: '2026-09-07',
      metrics: [
        {
          key: 'water',
          label: '水耗',
          unit: '吨',
          history: [period('2026-09-06', { A楼: 10 })],
        },
      ],
    });

    expect(result.status).toBe('unavailable');
    expect(result.count).toBe(1);
    expect(result.issues[0].title).toBe('2026-09-05、2026-09-04 水耗日数据缺失或不完整');
    expect(result.issues[0].detail).toContain('2026-09-05 水耗未取得完整有效日数据');
    expect(result.issues[0].detail).toContain('2026-09-04 水耗未取得完整有效日数据');
  });

  it('uses only the three calendar days before the patrol date', () => {
    const result = detectFacilityMetricIssues({
      businessDate: '2026-09-17',
      metrics: [{
        key: 'pue', label: 'PUE', unit: '',
        history: [
          period('2026-09-17', { A楼: 9 }),
          period('2026-09-16', { A楼: 1.5 }),
          period('2026-09-15', { A楼: 1 }),
          period('2026-09-14', { A楼: 1 }),
        ],
      }],
    });

    expect(result.status).toBe('alert');
    expect(result.count).toBe(1);
    expect(result.issues[0]).toMatchObject({ date: '2026-09-16', severity: 'warning' });
    expect(result.issues[0].title).toContain('50%');
  });

  it('does not replace a missing calendar day with an older complete day', () => {
    const result = detectFacilityMetricIssues({
      businessDate: '2026-09-17',
      metrics: [{
        key: 'pue', label: 'PUE', unit: '',
        history: [
          period('2026-09-16', { A楼: 1 }),
          period('2026-09-15', { A楼: 1 }),
          period('2026-09-13', { A楼: 1 }),
        ],
      }],
    });

    expect(result.status).toBe('unavailable');
    expect(result.issues[0].detail).toContain('2026-09-14 PUE未取得完整有效日数据');
  });

  it('finds same-day white-to-night and previous-night-to-white risks', () => {
    const schedules = [
      schedule('2026-09-06', 'night', '乙', 'C楼'),
      schedule('2026-09-07', 'white', '甲、乙', 'A楼'),
      schedule('2026-09-07', 'night', '甲', 'B楼'),
      schedule('2026-09-07', 'long_white', '丙', 'D楼'),
    ];

    const result = detectScheduleRisks(
      schedules,
      '2026-09-07',
      '2026-09-14',
    );

    expect(result.status).toBe('alert');
    expect(result.count).toBe(2);
    expect(result.issues.map((issue) => issue.title)).toEqual([
      '甲：白班后接夜班',
      '乙：夜班后接白班',
    ]);
  });

  it('finds a future change overlapping the sealing work window', () => {
    const changes = [
      {
        id: 'change-1',
        bitableRecordId: 'rec-change-1',
        title: '核心交换机变更',
        startDate: '2026-09-08T10:00:00+08:00',
        endDate: '2026-09-08T11:00:00+08:00',
        actualStartDate: null,
        actualEndDate: null,
      } as ChangeInfo,
    ];
    const sealings = [
      {
        id: 'sealing-1',
        bitableRecordId: 'rec-sealing-1',
        sealingCode: 'FW-1',
        sealingName: '重大活动封网',
        startDate: '2026-09-08T09:00:00+08:00',
        endDate: '2026-09-08T18:00:00+08:00',
      } as SealingInfo,
    ];

    const result = detectPlanConflicts(
      changes,
      sealings,
      '2026-09-07',
      '2026-09-14',
    );

    expect(result.status).toBe('alert');
    expect(result.count).toBe(1);
    expect(result.issues[0]).toMatchObject({
      title: '核心交换机变更 与封网冲突',
      date: '2026-09-08',
    });
    expect(result.issues[0].detail).toContain('重大活动封网');
  });

  it('keeps active weather warnings and filters released warnings', () => {
    const warnings: QWeatherWarningItem[] = [
      {
        id: 'active',
        title: '南通市雷电黄色预警',
        level: '黄色',
        status: '预警中',
        text: '预计未来六小时有雷电。',
      },
      {
        id: 'released',
        title: '南通市大风蓝色预警',
        status: '解除',
      },
    ];

    const result = detectWeatherAlerts(warnings);

    expect(result.status).toBe('alert');
    expect(result.count).toBe(1);
    expect(result.issues[0].title).toBe('南通市雷电黄色预警');
  });

  it('represents a failed source as an unavailable check', () => {
    const result = unavailablePatrolCheck(
      'weather',
      '天气告警',
      '天气接口超时',
    );

    expect(result).toMatchObject({
      key: 'weather',
      label: '天气告警',
      status: 'unavailable',
      count: 1,
    });
    expect(result.issues[0].detail).toBe('天气接口超时');
  });
});

function period(date: string, values: Record<string, number>) {
  return {
    date,
    rows: Object.entries(values).map(([building, value]) => ({
      building: building as 'A楼' | 'B楼' | 'C楼' | 'D楼' | 'E楼',
      value,
    })),
  };
}

function schedule(
  scheduleDate: string,
  shift: string,
  staff: string,
  building: string,
): MonthlySchedule {
  return {
    id: `${scheduleDate}-${shift}-${staff}-${building}`,
    recordId: `${scheduleDate}-${shift}-${building}`,
    dutyCode: null,
    scheduleDate,
    code: null,
    building,
    team: '',
    shift,
    personText: staff,
    dutyStaffReference: [],
    dutyStaffActual: staff.split('、'),
    remark: '',
    emergencyDuty: '',
    emergencyDutySchedule: '',
    leaveStaff: [],
    substituteStaff: [],
    actualDutyStaff: staff,
    buildingText: building,
    teamText: '',
    shiftText: shift,
    createdAt: '',
    updatedAt: '',
  };
}
