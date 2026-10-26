import type { BuildingAdminBuilding } from './access-control.interface';
import type { ProfessionalSpecialty } from './professional-access';
import type { AccessRole } from './access-control.interface';

export const AUTHORITY_DUTY_TABLE_NAME = '01-4 岗位职责与授权';
export const AUTHORITY_DUTY_CATALOG = [
  { id: 'building_supervisor', label: '楼栋示例人员001', buildingRequired: true, specialtyRequired: false, singleHolder: true },
  { id: 'warehouse_approver', label: '库房审批', buildingRequired: true, specialtyRequired: false, singleHolder: false },
  { id: 'warehouse_notify', label: '库房知会', buildingRequired: true, specialtyRequired: false, singleHolder: false },
  { id: 'purchase_manager', label: '采购经理审批', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'purchase_approver', label: '采购审批', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'purchase_executor', label: '综合采购执行', buildingRequired: false, specialtyRequired: false, singleHolder: true },
  { id: 'building_executor', label: '楼栋自采执行', buildingRequired: true, specialtyRequired: false, singleHolder: true },
  { id: 'contract_action', label: '合同处置', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'contract_notify', label: '合同通知', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'leave_supervisor', label: '请休假示例人员001审批', buildingRequired: true, specialtyRequired: false, singleHolder: true },
  { id: 'leave_manager', label: '请休假经理审批', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'overtime_supervisor', label: '加班示例人员001审批', buildingRequired: true, specialtyRequired: false, singleHolder: true },
  { id: 'overtime_manager', label: '加班经理审批', buildingRequired: false, specialtyRequired: false, singleHolder: false },
  { id: 'professional_supervisor', label: '专业示例人员001', buildingRequired: false, specialtyRequired: true, singleHolder: false },
  { id: 'professional_engineer', label: '工程师', buildingRequired: true, specialtyRequired: true, singleHolder: false },
] as const;
export type AuthorityDutyKind = typeof AUTHORITY_DUTY_CATALOG[number]['id'];
export function isAuthorityDutyKey(value: unknown): value is string {
  return typeof value === 'string' && (/^rec[A-Za-z0-9_]{1,97}$/.test(value) || /^position-[a-f0-9]{64}$/.test(value));
}
export function validAuthorityDutyOrigin(key: string, origin: unknown): boolean {
  return /^position-[a-f0-9]{64}$/.test(key) ? origin === 'personnel_position' : /^rec[A-Za-z0-9_]{1,97}$/.test(key) && origin === undefined;
}
export interface AuthorityDuty {
  /** position-* is a local derived duty key, never a cloud record ID. */
  recordId: string;
  origin?: 'personnel_position';
  name: string;
  kind: AuthorityDutyKind;
  personnelIds: string[];
  buildings: BuildingAdminBuilding[] | null;
  specialties: ProfessionalSpecialty[] | null;
  role?: AccessRole;
  enabled: boolean;
  startsAt: number;
  endsAt: number | null;
  parentDutyIds: string[];
  version: number;
}

export type AuthorityPersonType = 'employee' | 'duty_account' | 'collaborator';
export interface AuthorityPerson {
  id: string;
  recordId: string;
  name: string;
  openId?: string;
  active: boolean;
  type: AuthorityPersonType;
  position: string;
  systemPosition: string;
  buildings: BuildingAdminBuilding[];
  specialties: ProfessionalSpecialty[];
  permissionTags: string[];
  dutyRecordIds: string[];
}
export interface AuthorityPeopleSnapshot {
  people: AuthorityPerson[];
  problems: string[];
  issues: { recordId?: string; message: string }[];
}
export interface PersonnelAuthoritySnapshot extends AuthorityPeopleSnapshot {
  mode: 'shadow';
  version: string;
  snapshotAt: number;
  source: { appId: string; appToken: string; tableId: string; dutyTableId?: string; kind?: 'personnel_positions'; };
  duties: AuthorityDuty[];
}
