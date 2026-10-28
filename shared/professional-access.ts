import type { AccessPrincipal } from './access-control.interface';
import { canPerformBusinessAction, type BusinessPermissionContext } from './business-permissions';

export const PROFESSIONAL_SPECIALTIES = ['电气', '暖通', '弱电', '消防', 'EHS', '土建'] as const;
export type ProfessionalSpecialty = typeof PROFESSIONAL_SPECIALTIES[number];

export function normalizeProfessionalScope(value: unknown): ProfessionalSpecialty[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，;；/]/u) : [];
  const canonical = (item: string) => ({ '安全': 'EHS', '安全与环境': 'EHS', '供配电': '电气' }[item] || item);
  return PROFESSIONAL_SPECIALTIES.filter(specialty => values.some(item => typeof item === 'string' && canonical(item.trim().toUpperCase()) === specialty));
}

export function professionalScopeIsValid(value: unknown): value is ProfessionalSpecialty[] {
  return Array.isArray(value) && value.length > 0 && value.length <= PROFESSIONAL_SPECIALTIES.length &&
    value.every(item => PROFESSIONAL_SPECIALTIES.includes(item)) && new Set(value).size === value.length;
}

export function canManageProfessionalRecord(
  principal: Pick<AccessPrincipal, 'role' | 'specialties'> & Partial<AccessPrincipal>, specialty: unknown,
  building?: unknown, context: BusinessPermissionContext = principal.permissionContext || { module: 'equipment_ledger', action: 'read' },
): boolean {
  return [context,...(principal.permissionRequirements || []).filter(required=>required.module===context.module)]
    .every(required=>canPerformBusinessAction(principal,{...required,specialty,building}));
}
