export const MONTHLY_RESOURCE_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
] as const;
export type MonthlyResourceBuilding =
  (typeof MONTHLY_RESOURCE_BUILDINGS)[number];
export type MonthlyEnergyBuilding = MonthlyResourceBuilding | '园区';
export type MonthlyEnergyMetric =
  | 'pue'
  | 'total'
  | 'it'
  | 'nonIt'
  | 'cooling'
  | 'terminal'
  | 'auxiliary';
export interface MonthlyEnergyPoint {
  date: string;
  building: MonthlyEnergyBuilding;
  pue: number | null;
  total: number | null;
  it: number | null;
  nonIt: number | null;
  cooling: number | null;
  terminal: number | null;
  auxiliary: number | null;
  pueWeight: number | null;
}
export interface MonthlyRackRow {
  building: MonthlyResourceBuilding;
  date: string;
  capacity: number;
  online: number;
  rate: number;
}
export interface MonthlyRackMovement {
  id: string;
  date: string;
  building: MonthlyResourceBuilding;
  shift: string;
  poweredOn: number;
  poweredOff: number;
}
export interface MonthlySourceState {
  status: 'ready' | 'empty' | 'error' | 'stale';
  syncedAt: string | null;
  message?: string;
}
export interface MonthlyTemperaturePoint {
  date: string;
  building: MonthlyEnergyBuilding;
  value: number | null;
  samples: number;
}
export interface MonthlyOperationsResourcesResponse {
  range: { start: string; end: string; asOf: string; trendStart: string };
  racks: MonthlySourceState & {
    month: string | null;
    rows: MonthlyRackRow[];
    history: Array<{ month: string; rows: MonthlyRackRow[] }>;
  };
  rackMovements: MonthlySourceState & { rows: MonthlyRackMovement[] };
  energy: MonthlySourceState & { days: MonthlyEnergyPoint[] };
  weather: MonthlySourceState & { days: MonthlyTemperaturePoint[] };
  water: MonthlySourceState & { days: MonthlyWaterPoint[] };
  load: MonthlySourceState & {
    date: string | null;
    park: number | null;
    rows: Array<{ building: MonthlyResourceBuilding; value: number }>;
  };
}
export type MonthlyWaterMetric = 'water' | 'waterEast' | 'waterWest' | 'wue';
export interface MonthlyWaterPoint {
  date: string;
  building: MonthlyEnergyBuilding;
  water: number | null;
  waterEast: number | null;
  waterWest: number | null;
  wue: number | null;
  wueWeight: number | null;
}
