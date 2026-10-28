import type { AccessPrincipal, AccessRole } from './access-control.interface';
import {
  canPerformBusinessAction,
  type BusinessAction,
} from './business-permissions';

const CONSTRUCTION_MANUAL_REVIEW_AUTO_APPROVAL_ROLES = new Set<AccessRole>([
  'admin',
  'construction_admin',
  'editor',
]);

export function isConstructionManualReviewAutoApprovalRole(
  role: AccessRole,
  principal?: AccessPrincipal,
): boolean {
  return (
    CONSTRUCTION_MANUAL_REVIEW_AUTO_APPROVAL_ROLES.has(role) &&
    hasConstructionAction(principal, 'confirm')
  );
}

function hasConstructionAction(
  principal: AccessPrincipal | undefined,
  action: BusinessAction,
): boolean {
  // Legacy accepted tasks have only a role; profiles must retain every deny.
  if (!principal?.effectiveAuthorization && !principal?.personalRules?.length)
    return true;
  return canPerformBusinessAction(principal, {
    module: 'construction',
    action,
  });
}

export function isConstructionAttachmentReplacementAllowed(
  role: AccessRole,
  principal?: AccessPrincipal,
  permitOnly = false,
): boolean {
  const eligibleRole = permitOnly
    ? isConstructionManualReviewAutoApprovalRole(role, principal)
    : role === 'admin' || role === 'professional_admin';
  return (
    eligibleRole &&
    hasConstructionAction(principal, 'update') &&
    hasConstructionAction(principal, 'delete')
  );
}
