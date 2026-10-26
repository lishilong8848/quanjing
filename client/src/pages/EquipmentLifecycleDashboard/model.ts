import type { EquipmentLifecycleDashboardResponse } from '@shared/equipment-lifecycle.interface';

export type EquipmentLifecycleView = EquipmentLifecycleDashboardResponse;
export type LifecycleMonth = string;
export type LifecycleSummary = EquipmentLifecycleView['summary'];
export type BuildingUsage = EquipmentLifecycleView['buildingUsage'][number];
export type LongTermMaintenancePoint =
  EquipmentLifecycleView['longTermMaintenance'][number];
export type MaintenanceContractPoint =
  EquipmentLifecycleView['maintenanceContracts'][number];
export type KeyPartWarningPoint =
  EquipmentLifecycleView['keyPartWarnings'][number];
export type ExpiryHeatmapRow = EquipmentLifecycleView['expiryHeatmap'][number];
export type TopDeviceItem = EquipmentLifecycleView['topDevices'][number];
export type LifecycleAsset = EquipmentLifecycleView['assets'][number];
export type LifecycleFilterOptions = EquipmentLifecycleView['filterOptions'];
export type LifecycleRelatedRecord =
  EquipmentLifecycleView['relatedRecords']['longTermMaintenance'][number];

export type LifecycleDrilldownSource =
  | 'equipment'
  | 'longTermMaintenance'
  | 'keyParts'
  | 'maintenanceContracts';

export interface LifecycleDrilldownTarget {
  source: LifecycleDrilldownSource;
  title: string;
  description?: string;
  building?: string;
  status?: string;
  deviceName?: string;
  expiryMonth?: number;
}

export interface LifecycleDrilldownRow {
  id: string;
  source: LifecycleDrilldownSource;
  name: string;
  description: string;
  building: string;
  specialty: string;
  owner: string;
  status: string;
  dueDate: string | null;
}

export interface LifecycleDrilldownResult {
  title: string;
  description: string;
  rows: LifecycleDrilldownRow[];
}

export interface LifecycleFilters {
  building: 'all' | string;
  specialty: 'all' | string;
  manager: 'all' | string;
  status: 'all' | string;
}

export interface LifecyclePagination {
  items: LifecycleAsset[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const DEFAULT_LIFECYCLE_FILTERS: LifecycleFilters = {
  building: 'all',
  specialty: 'all',
  manager: 'all',
  status: 'all',
};

const DRILLDOWN_SOURCE_LABELS: Record<LifecycleDrilldownSource, string> = {
  equipment: '设备台账',
  longTermMaintenance: '长期维护项',
  keyParts: '关键器件',
  maintenanceContracts: '维护合同',
};

function cloneAsset(asset: LifecycleAsset): LifecycleAsset {
  return { ...asset };
}

export function filterLifecycleAssets(
  assets: readonly LifecycleAsset[],
  filters: LifecycleFilters,
): LifecycleAsset[] {
  return assets
    .filter(
      (asset) =>
        (filters.building === 'all' || asset.building === filters.building) &&
        (filters.specialty === 'all' ||
          asset.specialty === filters.specialty) &&
        (filters.manager === 'all' || asset.manager === filters.manager) &&
        (filters.status === 'all' || asset.status === filters.status),
    )
    .map(cloneAsset);
}

export function paginateLifecycleAssets(
  assets: readonly LifecycleAsset[],
  page: number,
  pageSize: number,
): LifecyclePagination {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const total = assets.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const start = (safePage - 1) * safePageSize;

  return {
    items: assets.slice(start, start + safePageSize).map(cloneAsset),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages,
  };
}

export function getLifecycleFilterOptions(
  assets: readonly LifecycleAsset[],
  serverOptions?: LifecycleFilterOptions,
): LifecycleFilterOptions {
  if (serverOptions) {
    return {
      buildings: [...serverOptions.buildings],
      specialties: [...serverOptions.specialties],
      managers: [...serverOptions.managers],
      statuses: [...serverOptions.statuses],
    };
  }

  const uniqueSorted = (values: readonly string[]) =>
    Array.from(new Set(values.filter(Boolean))).sort();

  return {
    buildings: uniqueSorted(assets.map((asset) => asset.building)),
    specialties: uniqueSorted(assets.map((asset) => asset.specialty)),
    managers: uniqueSorted(assets.map((asset) => asset.manager)),
    statuses: uniqueSorted(assets.map((asset) => asset.status)),
  };
}

export function getAssetCountsByBuilding(
  assets: readonly LifecycleAsset[],
  buildings: readonly string[],
): number[] {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    counts.set(asset.building, (counts.get(asset.building) || 0) + 1);
  }

  const orderedBuildings =
    buildings.length > 0 ? buildings : Array.from(counts.keys()).sort();

  return orderedBuildings.map((building) => counts.get(building) || 0);
}

export function buildLifecycleDrilldown(
  view: EquipmentLifecycleView,
  target: LifecycleDrilldownTarget,
): LifecycleDrilldownResult {
  const source = target.source;
  const rows =
    source === 'equipment'
      ? view.assets.map((asset) => ({
          id: asset.id,
          source,
          name: asset.deviceName,
          description: asset.description,
          building: asset.building,
          specialty: asset.specialty,
          owner: asset.manager,
          status: asset.status,
          dueDate: asset.currentExpiryDate,
        }))
      : (view.relatedRecords?.[source] ?? []).map((record) =>
          mapRelatedRecord(source, record),
        );

  const filteredRows = rows.filter(
    (row) =>
      (!target.building || row.building === target.building) &&
      (!target.status || row.status === target.status) &&
      (!target.deviceName || row.name === target.deviceName) &&
      (!target.expiryMonth ||
        getDateMonth(row.dueDate) === target.expiryMonth),
  );

  return {
    title: target.title,
    description:
      target.description ||
      `${DRILLDOWN_SOURCE_LABELS[target.source]} · 当前筛选结果`,
    rows: filteredRows.map((row) => ({ ...row })),
  };
}

function mapRelatedRecord(
  source: Exclude<LifecycleDrilldownSource, 'equipment'>,
  record: LifecycleRelatedRecord,
): LifecycleDrilldownRow {
  return {
    id: record.id,
    source,
    name: record.name,
    description: record.description,
    building: record.building,
    specialty: record.specialty,
    owner: record.owner,
    status: record.status,
    dueDate: record.dueDate,
  };
}

function getDateMonth(value: string | null): number | null {
  const match = value?.match(/^\d{4}-(\d{2})-\d{2}$/u);
  return match ? Number(match[1]) : null;
}

export function formatUpdatedAt(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return '—';

  const alreadyFormatted = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/,
  );
  if (alreadyFormatted) {
    const [, year, month, day, hour, minute] = alreadyFormatted;
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime())) return normalized;

  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}
