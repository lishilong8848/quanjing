import type { AccessRole } from './access-control.interface';

const CONSTRUCTION_MANUAL_REVIEW_AUTO_APPROVAL_ROLES = new Set<AccessRole>([
  'admin',
  'construction_admin',
  'editor',
]);

export function isConstructionManualReviewAutoApprovalRole(
  role: AccessRole,
): boolean {
  return CONSTRUCTION_MANUAL_REVIEW_AUTO_APPROVAL_ROLES.has(role);
}
