import type { MonthlySourceState } from './monthly-operations-resources.interface';

export type MonthlyChangeState =
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'delayed'
  | 'returned'
  | 'running'
  | 'planned'
  | 'pending';

export interface MonthlyChange {
  id: string;
  code: string;
  title: string;
  buildings: string[];
  specialty: string;
  type: string;
  workType: string;
  nature: string;
  level: string;
  date: string;
  plannedStart: string;
  plannedEnd: string | null;
  originalStart: string | null;
  originalEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  progress: string;
  result: string;
  state: MonthlyChangeState;
  risk: string;
  delayReason: string;
}

export interface MonthlyChangesResponse extends MonthlySourceState {
  range: { start: string; end: string; asOf: string };
  records: MonthlyChange[];
  invalid: number;
}
