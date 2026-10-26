import { AUTHORITY_DUTY_CATALOG, type AuthorityDuty } from './personnel-authority.interface';

export const PERSONNEL_HANDOVER_SCOPE = {
  modules: ['leave', 'overtime', 'inventory', 'purchase', 'contracts'],
  dutyKinds: AUTHORITY_DUTY_CATALOG.map(duty => duty.id),
} as const;

const SCOPED_SPECIALTY_KINDS = new Set(['professional_supervisor', 'professional_engineer', 'purchase_approver', 'purchase_executor', 'building_executor', 'contract_action', 'contract_notify']);

export function personnelHandoverScopeProblem(duty: Pick<AuthorityDuty, 'kind' | 'specialties'>): string | undefined {
  if (!PERSONNEL_HANDOVER_SCOPE.dutyKinds.includes(duty.kind)) return '该职责类型尚未接入交接';
  if (duty.specialties !== null && !SCOPED_SPECIALTY_KINDS.has(duty.kind)) return '该职责的历史待办缺少专业范围，需先核对';
  return undefined;
}
