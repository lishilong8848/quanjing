export interface MonthlyAlarmOverviewRecord {
  id: string;
  month: string;
  section: string;
  building: string;
  metric: string;
  quantity: number | null;
  period: string;
  week: string;
  description: string;
  confirmation: string;
  analysis: string;
  closed: string;
  event: string;
  problem: string;
  date: string;
  images: Array<{ name: string; mimeType: string; url: string }>;
}

export interface MonthlyAlarmOverviewResponse {
  records: MonthlyAlarmOverviewRecord[];
  months: string[];
  sourceStatus: 'ready' | 'stale' | 'empty' | 'error';
  syncedAt: string | null;
  warning: string;
}
