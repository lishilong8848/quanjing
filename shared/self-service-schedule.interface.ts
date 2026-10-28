import type { MonthlyScheduleResponse } from './api.interface';

/** A full source read projected to the authenticated person's own shifts only. */
export interface SelfServiceScheduleResponse extends MonthlyScheduleResponse {
  scope: 'self';
  applicantName: string;
  range: { startDate: string; endDate: string };
  complete: true;
}
