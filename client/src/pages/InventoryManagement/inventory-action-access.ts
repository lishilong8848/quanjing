import type { AccessPrincipal } from '@shared/access-control.interface';
import { decideBusinessPermission, hasBusinessPermissionSomewhere, type BusinessAction } from '@shared/business-permissions';

export function canUseInventoryAction(principal: AccessPrincipal, action: BusinessAction, record?: { building?: unknown; specialty?: unknown }): boolean {
  if (!principal.effectiveAuthorization) return true;
  return record
    ? decideBusinessPermission(principal, { module: 'inventory', action, building: record.building, specialty: record.specialty }).allowed
    : hasBusinessPermissionSomewhere(principal, { module: 'inventory', action });
}
