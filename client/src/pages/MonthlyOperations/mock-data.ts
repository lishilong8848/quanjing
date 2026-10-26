import {
  BUILDINGS,
  DEMO_AS_OF,
  type MonthlyData,
  type ResourceBuilding,
  type WorkKind,
  type WorkRecord,
  type WorkStatus,
} from './model';
import {
  DEMO_MONTHS,
  monthsInRange,
  resolvePeriod,
  type PeriodSelection,
} from './period';

const RESOURCE_SEEDS: ResourceBuilding[] = [
  {
    building: 'A楼',
    racks: 988,
    online: 970,
    poweredOn: 9,
    poweredOff: 2,
    load: 72.6,
    pue: 1.25,
    dailyIt: 354000,
    dailyWater: 438,
    waterReserve: 1400,
    fuelReserve: 112,
    backupHours: 28,
  },
  {
    building: 'B楼',
    racks: 1076,
    online: 1022,
    poweredOn: 12,
    poweredOff: 3,
    load: 74.1,
    pue: 1.24,
    dailyIt: 372000,
    dailyWater: 492,
    waterReserve: 1520,
    fuelReserve: 120,
    backupHours: 30,
  },
  {
    building: 'C楼',
    racks: 998,
    online: 970,
    poweredOn: 8,
    poweredOff: 2,
    load: 71.8,
    pue: 1.25,
    dailyIt: 347000,
    dailyWater: 471,
    waterReserve: 1380,
    fuelReserve: 110,
    backupHours: 27,
  },
  {
    building: 'D楼',
    racks: 988,
    online: 673,
    poweredOn: 26,
    poweredOff: 4,
    load: 43.2,
    pue: 1.29,
    dailyIt: 225000,
    dailyWater: 242,
    waterReserve: 1100,
    fuelReserve: 96,
    backupHours: 36,
  },
  {
    building: 'E楼',
    racks: 1272,
    online: 402,
    poweredOn: 24,
    poweredOff: 4,
    load: 22.7,
    pue: 1.58,
    dailyIt: 109000,
    dailyWater: 156,
    waterReserve: 980,
    fuelReserve: 88,
    backupHours: 42,
  },
];
const TITLES: Record<WorkKind, string[]> = {
  event: [
    '精密空调冷凝压力传感器异常',
    '冷冻水供水温度偏高',
    '空调控制屏显示异常',
    '冷却水加药装置管道渗漏',
    '直流电源电池状态告警',
    '柴油发电机试机异响',
  ],
  change: [
    '动环系统双机热备切换',
    '冷机群控策略优化',
    '低压配电柜计划切换',
    'BMS 点位逻辑校验',
    'UPS 旁路切换测试',
  ],
  drill: [
    '市电中断应急演练',
    '冷冻水泄漏应急演练',
    '消防联动实操演练',
    'UPS 故障应急演练',
    '高温天气保障演练',
  ],
  maintenance: [
    '风冷型空调季度维护',
    '蓄电池监控时间同步维护',
    '低压配电柜月度检查',
    '冷却塔传动系统保养',
    '气体灭火系统月度检查',
    '柴油发电机例行保养',
  ],
  alarm: [
    '冷冻水回水温度偏高',
    '空调滤网压差提醒',
    '机柜支路电流越限',
    '配电设备通讯中断',
    'UPS 电池内阻偏高',
  ],
  risk: [
    '供配电单点风险排查',
    '冷却系统冗余能力排查',
    '消防通道与联动风险排查',
    'UPS 电池运行风险排查',
    '机房环境与防水风险排查',
  ],
  inspection: [
    '精密空调凝露需处理',
    '配电柜标识缺失',
    '冷却水管保温层破损',
    '消防通道物品占用',
    '机房门禁闭门器异常',
  ],
};
const KIND_COUNTS: Record<WorkKind, number> = {
  event: 31,
  change: 13,
  drill: 20,
  maintenance: 207,
  alarm: 180,
  risk: 35,
  inspection: 18,
};
const COMPLETED: Record<WorkKind, number> = {
  event: 27,
  change: 11,
  drill: 12,
  maintenance: 76,
  alarm: 173,
  risk: 26,
  inspection: 13,
};

// Fixtures are deliberately isolated from API clients. Every displayed work count is derived from these rows.
export function createMonthlyDemo(month: string): MonthlyData {
  if (!DEMO_MONTHS.includes(month)) throw new Error('演示月份超出范围');
  const year = Number(month.slice(0, 4));
  const offset = (2026 - year) * 12 + 9 - Number(month.slice(-2));
  const days = new Date(
    Date.UTC(year, Number(month.slice(-2)), 0),
  ).getUTCDate();
  const asOf =
    month === DEMO_AS_OF.slice(0, 7) ? DEMO_AS_OF : `${month}-${days}`;
  const elapsedDays = Number(asOf.slice(-2));
  const resources = RESOURCE_SEEDS.map((item, index) => ({
    ...item,
    online: item.online - offset * (index + 8),
    poweredOn: item.poweredOn + offset * 2,
    poweredOff: item.poweredOff + offset,
    pue: item.pue + offset * 0.013,
    load: item.load - offset * 0.5,
    dailyIt: Math.round(item.dailyIt * (1 - offset * 0.018)),
    dailyWater: Math.round(item.dailyWater * (1 + offset * 0.05)),
  }));
  const records: WorkRecord[] = [];
  (Object.keys(KIND_COUNTS) as WorkKind[]).forEach((kind) => {
    const count = KIND_COUNTS[kind] + offset * (kind === 'alarm' ? 13 : 3);
    const completed =
      month === '2026-09'
        ? COMPLETED[kind]
        : count - (kind === 'maintenance' ? 3 : 1);
    for (let index = 0; index < count; index += 1) {
      const building =
        BUILDINGS[
          index %
            (['maintenance', 'alarm', 'risk', 'inspection'].includes(kind)
              ? 7
              : 5)
        ];
      let status: WorkStatus = 'done';
      if (index >= completed) {
        status =
          kind === 'maintenance'
            ? index < completed + 6
              ? 'overdue'
              : index < completed + 18
                ? 'active'
                : 'pending'
            : kind === 'drill' || kind === 'risk'
              ? 'pending'
              : kind === 'inspection' && index === completed
                ? 'overdue'
                : 'active';
      }
      const day =
        status === 'pending'
          ? Math.min(days, elapsedDays + 1 + (index % 12))
          : 1 + (index % elapsedDays);
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const specialty = ['暖通', '电气', '消防', '弱电'][index % 4];
      records.push({
        id: `DEMO-${kind.toUpperCase()}-${month.replace('-', '')}-${String(index + 1).padStart(3, '0')}`,
        kind,
        building,
        title: `${building} · ${TITLES[kind][index % TITLES[kind].length]}`,
        date,
        status,
        specialty,
        owner: `${building}${specialty}值班组`,
        source:
          kind === 'event' || kind === 'alarm'
            ? ['BMS系统', 'BMS系统', '巡检发现', 'BA系统', '维护发现'][
                index % 5
              ]
            : kind === 'change'
              ? index % 3
                ? '智航变更'
                : '客户变更'
              : kind === 'drill'
                ? ['计划演练', '客户抽演', '突袭演练'][index % 3]
                : kind === 'risk'
                  ? '专项排查'
                  : kind === 'inspection'
                    ? '现场巡检'
                    : '计划维护',
        level:
          kind === 'event'
            ? index % 8 === 0
              ? 'I2'
              : 'I3'
            : kind === 'alarm'
              ? index % 11 === 0
                ? '严重'
                : '一般'
              : kind === 'risk'
                ? status !== 'done'
                  ? '待排查'
                  : [
                      '未见风险',
                      '低风险',
                      '未见风险',
                      '中风险',
                      '未见风险',
                      '高风险',
                      '未见风险',
                    ][(Math.floor(index / 7) + index) % 7]
                : kind === 'inspection'
                  ? index % 4 === 0
                    ? '重点'
                    : '一般'
                  : '常规',
        score:
          kind === 'drill' && status === 'done' ? 80 + (index % 5) * 4 : null,
        recovered: kind === 'alarm' ? index < count - 4 : status === 'done',
      });
    }
  });
  return { month, asOf, resources, records };
}

const demoCache = new Map<string, MonthlyData>();
export function createPeriodDemo(selection: PeriodSelection): MonthlyData[] {
  const period = resolvePeriod(selection);
  return monthsInRange(period.start, period.asOf).map((month) => {
    if (!demoCache.has(month)) demoCache.set(month, createMonthlyDemo(month));
    return demoCache.get(month)!;
  });
}
