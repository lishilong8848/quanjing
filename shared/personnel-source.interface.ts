import type { AuthorityDutyKind } from './personnel-authority.interface';
import type { PersonnelDutyAssignment } from './personnel-duty-routing';
import type { CardRoleCode } from './access-configuration.interface';

export const PERSONNEL_SOURCE_MAX_AGE_MS = 26 * 60 * 60_000;
export type PersonnelSourceBinding = { appId: string; appToken: string; tableId: string } & (
  { kind: 'personnel_positions'; dutyTableId?: string } | { kind?: never; dutyTableId: string }
);
export function validPersonnelSourceBinding(value: unknown): value is PersonnelSourceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return !Object.keys(row).some(key => !['appId','appToken','tableId','dutyTableId','kind'].includes(key)) &&
    typeof row.appId === 'string' && /^cli_[A-Za-z0-9_-]+$/.test(row.appId) && typeof row.appToken === 'string' &&
    row.appToken.length > 0 && row.appToken.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(row.appToken) &&
    typeof row.tableId === 'string' && /^tbl[A-Za-z0-9_]+$/.test(row.tableId) &&
    (row.kind === 'personnel_positions' ? row.dutyTableId === undefined || typeof row.dutyTableId === 'string' && /^tbl[A-Za-z0-9_]+$/.test(row.dutyTableId) :
      row.kind === undefined && typeof row.dutyTableId === 'string' && /^tbl[A-Za-z0-9_]+$/.test(row.dutyTableId));
}
export interface PersonnelSourcePending {
  dutyRecordId: string;
  name: string;
  reason: string;
  candidate?: PersonnelDutyAssignment;
}
export interface PersonnelSourceState {
  status: 'active' | 'pending' | 'error' | 'paused';
  source: PersonnelSourceBinding;
  directoryVersion: string;
  activatedAt: number;
  lastSuccessAt: number;
  routes: Record<string, PersonnelDutyAssignment>;
  pending: PersonnelSourcePending[];
  error?: string;
}
export interface PersonnelSourcePreview {
  configurationRevision: number;
  directoryVersion: string;
  checkedAt: number;
  canActivate: boolean;
  problems: string[];
  unmanagedKinds?: AuthorityDutyKind[];
  rows: { dutyRecordId: string; name: string; kind: AuthorityDutyKind; buildings: string[] | null; specialties: string[] | null;
    members: string[]; status: 'aligned' | 'unconfirmed'; reason?: string; origin?: 'personnel_position' }[];
}
export interface PersonnelSourceMutation {
  clientMutationId: string;
  expectedRevision: number;
  expectedDirectoryVersion: string;
  action: 'activate' | 'pause';
}
export const PERSONNEL_SOURCE_CARD_DUTIES: Readonly<Record<CardRoleCode, AuthorityDutyKind>> = {
  purchase_manager: 'purchase_manager', purchase_approvers: 'purchase_approver', purchase_executor: 'purchase_executor',
  building_executor: 'building_executor', warehouse_responsible: 'warehouse_approver', warehouse_notify: 'warehouse_notify', contract_notify: 'contract_notify',
};
export function sourceOwnsCardRole(source: PersonnelSourceState | undefined, code: CardRoleCode, building: string | null): boolean {
  if (!source) return false;
  const kind = PERSONNEL_SOURCE_CARD_DUTIES[code];
  return [...Object.values(source.routes), ...source.pending.flatMap(item => item.candidate ? [item.candidate] : [])]
    .some(rule => rule.kind === kind && (building === null || rule.buildings === null || rule.buildings.includes(building as never)));
}
