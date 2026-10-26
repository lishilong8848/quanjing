import type { LedgerAsset } from './equipment-ledger.interface';

export interface EquipmentRepairHistory {
  id: string;
  repairNumber: string;
  status: string;
  faultAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  fault: string;
  cause: string;
  result: string;
  parts: string;
  actions: string;
}

export interface EquipmentHistoryDevice {
  asset: LedgerAsset;
  count: number;
  completed: number;
  pending: number;
  lastFaultAt: string | null;
  latestFault: string;
}

export interface EquipmentHistoryDevicesState {
  status: 'loading' | 'ready' | 'error';
  refreshing: boolean;
  stale: boolean;
  updatedAt: string | null;
  devices: EquipmentHistoryDevice[];
  error: string;
}

export interface EquipmentHistoryState {
  assetId: string;
  status: 'loading' | 'ready' | 'error';
  refreshing: boolean;
  stale: boolean;
  updatedAt: string | null;
  items: EquipmentRepairHistory[];
  error: string;
}
