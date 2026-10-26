export type PanoramaTone =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'orange'
  | 'red'
  | 'purple';

export type PanoramaDirection = 'up' | 'down' | 'neutral';

export interface PanoramaKpi {
  key: string;
  title: string;
  value: string;
  unit: string;
  comparison: string;
  direction: PanoramaDirection;
  tone: PanoramaTone;
  icon: string;
  sparkline: number[];
  helpText?: string;
}

export interface PanoramaAlarmKpi extends PanoramaKpi {
  progress?: number;
}

export interface RackBuildingLoad {
  building: string;
  value: number;
}

export interface RackBuildingUsage {
  building: string;
  online: number;
  total: number;
  usageRate: number;
}

export interface PanoramaRackSummary {
  usageRate: number;
  online: number;
  total: number;
  capacityDate: string | null;
  onlineThisPeriod: number;
  onlineDelta: string;
  offlineThisPeriod: number;
  offlineDelta: string;
  buildingLoads: RackBuildingLoad[];
  buildingUsages: RackBuildingUsage[];
}

export interface MaintenanceRow {
  label: string;
  value: string;
}

export interface MaintenanceCard {
  key: string;
  title: string;
  count: number;
  icon: string;
  tone: PanoramaTone;
  rows: MaintenanceRow[];
  footer: string;
  featured?: boolean;
  sourceUnavailable?: boolean;
}

export const PANORAMA_KPIS: PanoramaKpi[] = [
  {
    key: 'running-days',
    title: '全维运行天数',
    value: '--',
    unit: '天',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'blue',
    icon: 'shield',
    sparkline: [],
  },
  {
    key: 'on-duty',
    title: '今日在岗人数',
    value: '--',
    unit: '人',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'blue',
    icon: 'users',
    sparkline: [],
  },
  {
    key: 'average-pue',
    title: '平均PUE',
    value: '--',
    unit: '',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'green',
    icon: 'zap',
    sparkline: [],
  },
  {
    key: 'it-load',
    title: 'IT负载率',
    value: '--',
    unit: '%',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'blue',
    icon: 'gauge',
    sparkline: [],
  },
  {
    key: 'electricity',
    title: '用电量',
    value: '--',
    unit: 'KWh',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'purple',
    icon: 'zap',
    sparkline: [],
  },
  {
    key: 'water',
    title: '耗水量',
    value: '--',
    unit: 't',
    comparison: '正在读取',
    direction: 'neutral',
    tone: 'cyan',
    icon: 'water',
    sparkline: [],
  },
];

export const PANORAMA_RACK_SUMMARY: PanoramaRackSummary = {
  usageRate: 74,
  online: 1690,
  total: 2292,
  capacityDate: null,
  onlineThisPeriod: 58,
  onlineDelta: '▲ 12',
  offlineThisPeriod: 0,
  offlineDelta: '--',
  buildingLoads: [
    { building: 'A栋', value: 67.2 },
    { building: 'B栋', value: 69.2 },
    { building: 'C栋', value: 75.6 },
    { building: 'D栋', value: 62.6 },
    { building: 'E栋', value: 31.9 },
  ],
  buildingUsages: [
    { building: 'A栋', online: 400, total: 500, usageRate: 80 },
    { building: 'B栋', online: 350, total: 500, usageRate: 70 },
    { building: 'C栋', online: 400, total: 500, usageRate: 80 },
    { building: 'D栋', online: 300, total: 400, usageRate: 75 },
    { building: 'E栋', online: 240, total: 392, usageRate: 61.2 },
  ],
};

export const PANORAMA_MAINTENANCE_CARDS: MaintenanceCard[] = [
  {
    key: 'events',
    title: '今日事件',
    count: 4,
    icon: 'siren',
    tone: 'red',
    rows: [
      { label: '今日事件', value: '4 个' },
      { label: '重点事件', value: '2 个' },
    ],
    footer: '重点关注：2 个待处理',
  },
  {
    key: 'changes',
    title: '今日变更',
    count: 4,
    icon: 'panels',
    tone: 'green',
    rows: [
      { label: '今日变更', value: '4 个' },
      { label: '重点变更', value: '1 个' },
    ],
    footer: '重要变更：1 个待审批',
    featured: true,
  },
  {
    key: 'inspections',
    title: '今日检修',
    count: 4,
    icon: 'wrench',
    tone: 'blue',
    rows: [
      { label: '计划检修', value: '4 个' },
      { label: '进行中检修', value: '1 个' },
    ],
    footer: '进行中：1 个',
  },
  {
    key: 'maintenance',
    title: '今日维保',
    count: 0,
    icon: 'shield',
    tone: 'purple',
    rows: [
      { label: '计划维保', value: '0 个' },
      { label: '进行中维保', value: '0 个' },
    ],
    footer: '全部完成',
  },
  {
    key: 'network-freeze',
    title: '今日封网情况',
    count: 0,
    icon: 'lock',
    tone: 'orange',
    rows: [
      { label: '今日封网', value: '0 个' },
      { label: '未来7天封网', value: '0 个' },
    ],
    footer: '无封网计划',
  },
  {
    key: 'other-items',
    title: '其他事宜',
    count: 0,
    icon: 'star',
    tone: 'green',
    rows: [
      { label: '今日施工', value: '0 项' },
      { label: '其他事宜', value: '0 项' },
    ],
    footer: '其他事宜：0 项',
  },
];
