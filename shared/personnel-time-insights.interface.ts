export interface PersonnelTimeInsightsRange {
  from: string;
  through: string;
}

export interface PersonnelTimeInsightsMetrics {
  overtimePeople: number;
  overtimeHours: number;
  overtimePayHours: number;
  feeSettlementHours: number;
  compensatoryAccruedHours: number;
  compensatoryUsedHours: number;
  compensatoryAvailableHours: number;
  leaveHours: number;
  travelHours: number;
}

export interface PersonnelTimeInsightsMonthlyPoint {
  month: string;
  overtimeHours: number;
  leaveHours: number;
  travelHours: number;
  compensatoryAccruedHours: number;
  compensatoryUsedHours: number;
}

export type PersonnelTimeInsightsOvertimeDisposition =
  | '调休'
  | '加班费'
  | '费用结算';

export interface PersonnelTimeInsightsOvertimeDetail {
  recordId: string;
  startAt: string;
  endAt?: string;
  hours: number;
  disposition: PersonnelTimeInsightsOvertimeDisposition;
  legacyDefaultedDisposition: boolean;
}

export interface PersonnelTimeInsightsPendingOvertimeDetail {
  recordId: string;
  startAt: string;
  endAt: string;
  hours: number;
}

export interface PersonnelTimeInsightsLeaveDetail {
  recordId: string;
  date: string;
  startAt: string;
  endAt: string;
  hours: number;
  leaveType: string;
  travel: boolean;
  legacyStartDateFallback: boolean;
}

export interface PersonnelTimeInsightsPersonSummary extends PersonnelTimeInsightsMetrics {
  key: string;
  name: string;
  openId: string | null;
  building: string;
  position: string;
  pendingOvertimeCount: number;
  details: {
    overtime: PersonnelTimeInsightsOvertimeDetail[];
    leave: PersonnelTimeInsightsLeaveDetail[];
    pendingOvertime?: PersonnelTimeInsightsPendingOvertimeDetail[];
  };
}

export interface PersonnelTimeInsightsBuildingSummary extends PersonnelTimeInsightsMetrics {
  building: string;
  peopleCount: number;
  pendingOvertimeCount: number;
}

export interface PersonnelTimeInsightsResponse {
  range: PersonnelTimeInsightsRange;
  metrics: PersonnelTimeInsightsMetrics;
  monthly: PersonnelTimeInsightsMonthlyPoint[];
  buildings: PersonnelTimeInsightsBuildingSummary[];
  people: PersonnelTimeInsightsPersonSummary[];
  pendingOvertime: {
    count: number;
    people: string[];
  };
  quality: {
    legacyDefaultedCompensatoryCount: number;
    legacyLeaveStartDateCount: number;
  };
}
