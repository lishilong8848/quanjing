import type { MonthlySourceState } from './monthly-operations-resources.interface';

export type AssessmentKind = 'risk' | 'drill' | 'event' | 'inspection';
export interface AssessmentRow {
  id: string;
  code: string;
  title: string;
  building: string;
  date: string | null;
  status: string;
  tags: string[];
  planned: number | null;
  checked: number | null;
  approved: number | null;
  done: boolean;
  detail: Array<{ label: string; value: string }>;
  groupedEvents?: Array<{
    id: string;
    code: string;
    title: string;
    occurredAt: string;
    status: string;
    tags: string[];
  }>;
}
export interface AssessmentResponse extends MonthlySourceState {
  kind: AssessmentKind;
  range: { start: string; end: string; asOf: string };
  records: AssessmentRow[];
  invalid: number;
  openRisks?: OpenRiskItem[];
  openRiskStatus?: MonthlySourceState;
}

export interface OpenRiskItem {
  id: string;
  code: string;
  building: string;
  level: string;
  category: string;
  description: string;
  inspectionDate: string | null;
  inspectionStatus: string;
  currentStatus: string;
  finding: string;
  inspectionId: string | null;
}
