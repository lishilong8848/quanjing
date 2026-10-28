import type { AccessPrincipal } from '@shared/access-control.interface';
import { hasBusinessPermissionSomewhere, type BusinessAction, type BusinessModule } from '@shared/business-permissions';

/** Preserve legacy checks until an explicit authorization profile exists. */
export function canUsePageAction(principal: AccessPrincipal, module: BusinessModule, action: BusinessAction, legacyAllowed: boolean): boolean {
  return principal.effectiveAuthorization ? hasBusinessPermissionSomewhere(principal, { module, action }) : legacyAllowed;
}
