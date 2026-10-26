import type { AccessRole } from './access-control.interface';

const PERSON_PROFILE_DETAIL_ROLES = new Set<AccessRole>([
  'admin',
  'editor',
  'duty_editor',
]);

export function canViewPersonProfileDetails(role: AccessRole): boolean {
  return PERSON_PROFILE_DETAIL_ROLES.has(role);
}
