export type TodayOperationsKpiSourceStatus = 'fresh' | 'stale';

export interface TodayOperationsKpiMetric {
  value: number;
  previousValue: number | null;
  date: string | null;
}

export type TodayOperationsKpiBuilding =
  | 'A楼'
  | 'B楼'
  | 'C楼'
  | 'D楼'
  | 'E楼';

export interface TodayOperationsKpiBuildingMetricRow {
  building: TodayOperationsKpiBuilding;
  value: number | null;
  previousValue: number | null;
}

export interface TodayOperationsKpiBuildingMetricHistoryPeriod {
  date: string;
  rows: Array<{
    building: TodayOperationsKpiBuilding;
    value: number;
  }>;
}

export interface TodayOperationsKpiBuildingMetricDetails {
  date: string;
  previousDate: string | null;
  includedBuildings: TodayOperationsKpiBuilding[];
  rows: TodayOperationsKpiBuildingMetricRow[];
  history?: TodayOperationsKpiBuildingMetricHistoryPeriod[];
}

export interface TodayOperationsKpiBuildingMetrics {
  averagePue: TodayOperationsKpiBuildingMetricDetails;
  electricityKwh: TodayOperationsKpiBuildingMetricDetails;
  waterTons: TodayOperationsKpiBuildingMetricDetails;
}

export interface TodayOperationsKpiMetrics {
  safeOperationDays: TodayOperationsKpiMetric;
  onDutyPeople: TodayOperationsKpiMetric;
  averagePue: TodayOperationsKpiMetric;
  itLoadRate: TodayOperationsKpiMetric;
  electricityKwh: TodayOperationsKpiMetric;
  waterTons: TodayOperationsKpiMetric;
}

export type TodayOperationsOnDutyShift = 'white' | 'night';

export type TodayOperationsOnDutyPersonStatus =
  | 'on_duty'
  | 'leave'
  | 'time_off'
  | 'substitute'
  | 'vacancy_substitute'
  | 'travel';

export interface TodayOperationsOnDutyPerson {
  name: string;
  status: TodayOperationsOnDutyPersonStatus;
  statusLabel: string;
  onDuty: boolean;
  relatedStaff: string[];
}

export interface TodayOperationsOnDutyBuilding {
  building: string;
  buildingName: string;
  staff: string[];
  people: TodayOperationsOnDutyPerson[];
}

export interface TodayOperationsOnDutyShiftDetails {
  shift: TodayOperationsOnDutyShift;
  shiftLabel: string;
  total: number;
  buildings: TodayOperationsOnDutyBuilding[];
}

export interface TodayOperationsOnDutyPeopleDetails {
  scope: 'daily_shifts';
  date: string;
  /** 白班兼容字段；新代码优先读取 shifts.white.buildings。 */
  buildings: TodayOperationsOnDutyBuilding[];
  /** 白班兼容字段；与 whiteShiftTotal 相同。 */
  total: number;
  whiteShiftTotal: number;
  nightShiftTotal: number;
  shifts: {
    white: TodayOperationsOnDutyShiftDetails;
    night: TodayOperationsOnDutyShiftDetails;
  };
}

export interface TodayOperationsKpiDetails {
  onDutyPeople: TodayOperationsOnDutyPeopleDetails;
  /** 兼容升级期间的旧缓存响应；新响应始终返回。 */
  buildingMetrics?: TodayOperationsKpiBuildingMetrics;
}

export interface TodayOperationsKpiResponse {
  sourceStatus: TodayOperationsKpiSourceStatus;
  syncedAt: string;
  metrics: TodayOperationsKpiMetrics;
  details: TodayOperationsKpiDetails;
}
