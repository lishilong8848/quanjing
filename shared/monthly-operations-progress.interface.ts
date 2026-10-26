import type { MonthlySourceState } from './monthly-operations-resources.interface';

export interface ZhihangChangeProgress {
  id: string;
  code: string;
  workOrder: string;
  title: string;
  buildings: string[];
  type: string;
  category: string;
  level: string;
  node: string;
  status: string;
  executionStatus: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  deferredStart: string | null;
  deferredEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  updatedAt: string | null;
}

export interface ZhihangProgressResponse extends MonthlySourceState {
  range: { start: string; end: string; asOf: string };
  records: ZhihangChangeProgress[];
  invalid: number;
}
