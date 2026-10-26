export const EQUIPMENT_PATROL_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
] as const;

export type EquipmentPatrolBuilding =
  (typeof EQUIPMENT_PATROL_BUILDINGS)[number];

export const EQUIPMENT_PATROL_CATEGORIES = [
  '制冷单元',
  '辅助区域精密空调',
  '二次泵',
  '东西区变频补水机组',
  '包间空调（备机）',
  '水质循环',
  '其他',
] as const;

export type EquipmentPatrolCategory =
  (typeof EQUIPMENT_PATROL_CATEGORIES)[number];

export type EquipmentPatrolExecutionStatus = '开始' | '更新' | '结束' | '未知';

export type EquipmentPatrolQualityFlag =
  | 'building_inferred'
  | 'building_missing'
  | 'plan_time_invalid'
  | 'actual_time_invalid'
  | 'actual_time_drift';

export interface EquipmentPatrolExecutionRecord {
  recordId: string;
  title: string;
  building: EquipmentPatrolBuilding | null;
  buildingSource: 'field' | 'title' | 'missing';
  equipment: string;
  specialty: string;
  categories: EquipmentPatrolCategory[];
  planStart: string | null;
  planEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  progress: string;
  status: EquipmentPatrolExecutionStatus;
  content: string;
  updatedAt: string | null;
  nonPlanned: boolean;
  qualityFlags: EquipmentPatrolQualityFlag[];
}

export interface EquipmentPatrolExecutionResponse {
  month: string;
  generatedAt: string;
  sourceUpdatedAt: string | null;
  sourceUrl: string;
  sourceMode: 'live' | 'snapshot';
  stale: boolean;
  totalSourceRecords: number;
  records: EquipmentPatrolExecutionRecord[];
  warnings: string[];
}
