export type TodayOperationsOverviewSourceStatus = 'fresh' | 'stale' | 'partial';

export interface TodayOperationsRackBuildingLoad {
  building: 'A楼' | 'B楼' | 'C楼' | 'D楼' | 'E楼';
  value: number;
}

export interface TodayOperationsRackBuildingUsage {
  building: 'A楼' | 'B楼' | 'C楼' | 'D楼' | 'E楼';
  online: number;
  total: number;
  usageRate: number;
}

export interface TodayOperationsRackSummary {
  usageRate: number;
  online: number;
  total: number;
  buildingUsages: TodayOperationsRackBuildingUsage[];
  poweredOnThisWeek: number;
  poweredOffThisWeek: number;
  poweredOnWeekDelta: number | null;
  poweredOffWeekDelta: number | null;
  weekStartDate: string;
  capacityDate: string | null;
  loadDate: string | null;
  buildingLoads: TodayOperationsRackBuildingLoad[];
}

export interface TodayOperationsWorkSummary {
  todayEvents: number;
  pendingEvents: number;
  priorPendingEvents: number;
  closedTodayEvents: number;
  keyEvents: number;
  todayChanges: number;
  activeChanges: number;
  priorActiveChanges: number;
  keyChanges: number;
  todayInspections: number;
  activeInspections: number;
  todayMaintenance: number;
  activeMaintenance: number;
}

export type TodayOperationsWorkKind =
  | 'events'
  | 'changes'
  | 'inspections'
  | 'maintenance';

export interface TodayOperationsWorkItem {
  id: string;
  code: string | null;
  title: string;
  summary: string | null;
  method: string | null;
  durationDays: number | null;
  level: string | null;
  riskLevel: string | null;
  status: string | null;
  owner: string | null;
  startTime: string | null;
  endTime: string | null;
  building: string | null;
  specialty: string | null;
  isKey: boolean;
}

export type TodayOperationsWorkDetails = Record<
  TodayOperationsWorkKind,
  TodayOperationsWorkItem[]
>;

export interface TodayOperationsFocusDetails {
  pendingEvents: TodayOperationsWorkItem[];
  activeChanges: TodayOperationsWorkItem[];
}

export type TodayOperationsWorkSourceStatus = 'fresh' | 'stale' | 'failed';

export interface TodayOperationsWorkSourceState {
  status: TodayOperationsWorkSourceStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export type TodayOperationsWorkSourceStates = Record<
  TodayOperationsWorkKind,
  TodayOperationsWorkSourceState
>;

export interface TodayOperationsOverviewResponse {
  businessDate: string;
  sourceStatus: TodayOperationsOverviewSourceStatus;
  syncedAt: string;
  rackSummary: TodayOperationsRackSummary | null;
  rackSourceState?: TodayOperationsWorkSourceState;
  operations: TodayOperationsWorkSummary;
  details: TodayOperationsWorkDetails;
  focusDetails: TodayOperationsFocusDetails;
  sourceStates: TodayOperationsWorkSourceStates;
}
