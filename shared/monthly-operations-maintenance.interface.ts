import type { AssessmentRow } from './monthly-operations-assessment.interface';
import type { MonthlySourceState } from './monthly-operations-resources.interface';
export type MaintenanceType = 'planned' | 'unplanned';
export interface MaintenanceRow extends AssessmentRow {
  planType: MaintenanceType;
  specialty: string;
  abnormal: boolean;
  running: boolean;
}
export interface MaintenanceResponse extends MonthlySourceState {
  kind: MaintenanceType;
  range: { start: string; end: string; asOf: string };
  records: MaintenanceRow[];
  invalid: number;
}
