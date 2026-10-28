import type { AccessRole, AccessPrincipal } from './access-control.interface';
import { hasBusinessPermissionSomewhere } from './business-permissions';

const PERSON_PROFILE_DETAIL_ROLES = new Set<AccessRole>([
  'admin',
  'editor',
  'duty_editor',
]);

export function canViewPersonProfileDetails(principal: AccessRole | AccessPrincipal): boolean {
  if(typeof principal!=='string' && principal.effectiveAuthorization) return hasBusinessPermissionSomewhere(principal,{module:'personnel_profile',action:'read'});
  return PERSON_PROFILE_DETAIL_ROLES.has(typeof principal==='string'?principal:principal.role);
}
