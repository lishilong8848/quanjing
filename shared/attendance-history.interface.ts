export type AttendanceHistoryCategory =
  | 'late'
  | 'early'
  | 'missing'
  | 'corrected'
  | 'other';

export interface AttendanceHistoryItem {
  key: string;
  date: string;
  businessDate?: string;
  building: string;
  name: string;
  shiftLabel: string;
  direction: 'OnDuty' | 'OffDuty';
  expectedAt: string;
  reason: string;
  category: AttendanceHistoryCategory;
  categoryLabel: string;
}

export interface AttendanceHistoryCategoryBreakdown {
  category: AttendanceHistoryCategory;
  label: string;
  count: number;
}

export interface AttendanceHistoryPersonRanking {
  name: string;
  buildings: string[];
  count: number;
}

export interface AttendanceHistoryBuildingRanking {
  building: string;
  peopleCount: number;
  count: number;
}

export interface AttendanceHistoryResponse {
  startDate: string;
  endDate: string;
  fetchedAt: string;
  checkedCount: number;
  anomalyCount: number;
  abnormalPeople: number;
  affectedBuildings: number;
  correctedCount: number;
  items: AttendanceHistoryItem[];
  categoryBreakdown: AttendanceHistoryCategoryBreakdown[];
  personRanking: AttendanceHistoryPersonRanking[];
  buildingRanking: AttendanceHistoryBuildingRanking[];
}
