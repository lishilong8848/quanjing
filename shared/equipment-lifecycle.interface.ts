export type EquipmentLifecycleSourceStatus = 'fresh' | 'stale' | 'partial';

export type EquipmentLifecycleTableStatus = 'fresh' | 'stale' | 'failed';

export type EquipmentLifecycleSourceTableKey =
  | 'equipment'
  | 'longTermMaintenance'
  | 'keyParts'
  | 'maintenanceContracts';

export interface EquipmentLifecycleSummary {
  equipmentTotal: number | null;
  keyPartTotal: number | null;
  expiringEquipment: number | null;
  expiredContracts: number | null;
  maintenanceContracts: number | null;
  longTermMaintenance: number | null;
}

export interface EquipmentLifecycleBuildingUsage {
  building: string;
  notExpiredRate: number;
  evaluationRate: number;
  notExpired: number;
  evaluation: number;
}

export interface EquipmentLifecycleLongTermMaintenancePoint {
  building: string;
  inWarranty: number;
  expired: number;
}

export interface EquipmentLifecycleStatusPoint {
  building: string;
  inWarranty: number;
  warning: number;
  expired: number;
}

export interface EquipmentLifecycleExpiryHeatmapRow {
  building: string;
  values: number[];
}

export interface EquipmentLifecycleTopDevice {
  id: string;
  name: string;
  count: number;
}

export interface EquipmentLifecycleAsset {
  id: string;
  description: string;
  building: string;
  deviceName: string;
  specialty: string;
  manager: string;
  managerInitial: string;
  serviceYears: number | null;
  lastReplacementDate: string | null;
  currentExpiryDate: string | null;
  status: string;
  nextReplacementDate: string | null;
}

export interface EquipmentLifecycleRelatedRecord {
  id: string;
  description: string;
  name: string;
  building: string;
  specialty: string;
  owner: string;
  status: string;
  previousDate: string | null;
  dueDate: string | null;
  nextDate: string | null;
  countdownDays: number | null;
}

export interface EquipmentLifecycleRelatedRecords {
  longTermMaintenance: EquipmentLifecycleRelatedRecord[];
  keyParts: EquipmentLifecycleRelatedRecord[];
  maintenanceContracts: EquipmentLifecycleRelatedRecord[];
}

export interface EquipmentLifecycleFilterOptions {
  buildings: string[];
  specialties: string[];
  managers: string[];
  statuses: string[];
}

export interface EquipmentLifecycleSourceTable {
  key: EquipmentLifecycleSourceTableKey;
  status: EquipmentLifecycleTableStatus;
  recordCount: number | null;
  updatedAt: string | null;
}

export interface EquipmentLifecycleDashboardResponse {
  month: string;
  availableMonths: string[];
  updatedAt: string;
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: EquipmentLifecycleSourceStatus;
  warnings: string[];
  summary: EquipmentLifecycleSummary;
  maintenanceContractInWarrantyRate: number | null;
  buildingUsage: EquipmentLifecycleBuildingUsage[];
  longTermMaintenance: EquipmentLifecycleLongTermMaintenancePoint[];
  maintenanceContracts: EquipmentLifecycleStatusPoint[];
  keyPartWarnings: EquipmentLifecycleStatusPoint[];
  expiryHeatmap: EquipmentLifecycleExpiryHeatmapRow[];
  topDevices: EquipmentLifecycleTopDevice[];
  filterOptions: EquipmentLifecycleFilterOptions;
  assets: EquipmentLifecycleAsset[];
  relatedRecords: EquipmentLifecycleRelatedRecords;
  sourceTables: EquipmentLifecycleSourceTable[];
}

export type EquipmentLifecycleView = EquipmentLifecycleDashboardResponse;
