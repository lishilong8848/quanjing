import type { EquipmentLifecycleRelatedRecord } from './equipment-lifecycle.interface';

export type LedgerWarranty = '在保' | '过保' | '待确认';
export type LedgerKind = 'detail' | 'collection';
export interface LedgerAsset {
  id: string;
  code: string;
  sourceCode: string;
  name: string;
  building: string;
  category: string;
  specialty: string;
  brand: string;
  model: string;
  quantity: number | null;
  location: string;
  installedAt: string | null;
  warrantyUntil: string | null;
  warrantyYears: number | null;
  warrantySource: string;
  warranty: LedgerWarranty;
  kind: LedgerKind;
  serial: string;
  assetCode: string;
  capacity: string;
  operatingMode: string;
  parameters: string;
  differences: string;
  collectionAudit: string;
}
export interface LedgerPoint {
  name: string;
  count: number;
}
export interface LedgerFamilyPoint extends LedgerPoint {
  inWarranty: number;
  expired: number;
  pending: number;
}
export interface LedgerSystemPoint extends LedgerPoint {
  kindCount: number;
  families: string[];
}
export interface LedgerMetrics {
  total: number;
  inWarranty: number;
  expired: number;
  pending: number;
  categories: number;
  models: number;
  collections: number;
}
export interface LedgerSummary {
  building: string;
  metrics: LedgerMetrics;
  categories: LedgerPoint[];
  models: LedgerPoint[];
  brands: LedgerPoint[];
  warranties: LedgerPoint[];
  families: LedgerFamilyPoint[];
  systems: LedgerSystemPoint[];
}
export interface LedgerDashboard {
  snapshotId: string;
  updatedAt: string;
  asOf: string;
  stale: boolean;
  overview: LedgerSummary;
  buildings: LedgerSummary[];
}
export interface LedgerDashboardState {
  status: 'loading' | 'ready' | 'error';
  dashboard: LedgerDashboard | null;
  refreshing: boolean;
  error: string;
}
export interface LedgerLifecycle {
  status: 'fresh' | 'stale' | 'partial';
  assets: Array<{
    id: string;
    building: string;
    name: string;
    status: string;
    dueDate: string | null;
  }>;
  longTermMaintenance: EquipmentLifecycleRelatedRecord[];
  keyParts: EquipmentLifecycleRelatedRecord[];
  maintenanceContracts: EquipmentLifecycleRelatedRecord[];
}
export interface LedgerQuery {
  id?: string;
  building?: string;
  category?: string;
  family?: string;
  system?: string;
  management?: string;
  brand?: string;
  model?: string;
  warranty?: string;
  kind?: LedgerKind;
  search?: string;
  page?: number;
  pageSize?: number;
}
export interface LedgerPage {
  snapshotId: string;
  updatedAt: string;
  asOf: string;
  stale: boolean;
  items: LedgerAsset[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
