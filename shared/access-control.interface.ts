import type { ProfessionalSpecialty } from './professional-access';

export const PURCHASE_ACCESS_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
] as const;

export type PurchaseAccessBuilding = (typeof PURCHASE_ACCESS_BUILDINGS)[number];
export const BUILDING_ADMIN_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const;
export type BuildingAdminBuilding = (typeof BUILDING_ADMIN_BUILDINGS)[number];

export type AccessRole =
  | 'guest'
  | 'site_member'
  | 'editor'
  | 'admin'
  | 'inventory_admin'
  | 'building_admin'
  | 'purchase_admin'
  | 'purchase_applicant'
  | 'duty_editor'
  | 'supply_chain_admin'
  | 'professional_admin'
  | 'professional_engineer'
  | 'construction_admin';

export const CHANGE_DRILL_REPORT_ALLOWED_ROLES = [
  'admin',
  'editor',
  'duty_editor',
] as const satisfies readonly AccessRole[];

export function canSubmitChangeDrillReportForRole(role: AccessRole): boolean {
  return (CHANGE_DRILL_REPORT_ALLOWED_ROLES as readonly AccessRole[]).includes(
    role,
  );
}

export const CHANGE_SUMMARY_REPORT_ALLOWED_ROLES = [
  'admin',
  'editor',
  'duty_editor',
] as const satisfies readonly AccessRole[];

export function canSubmitChangeSummaryReportForRole(role: AccessRole): boolean {
  return (
    CHANGE_SUMMARY_REPORT_ALLOWED_ROLES as readonly AccessRole[]
  ).includes(role);
}

export function canStageChangeAttachmentForRole(
  role: AccessRole | undefined,
  ownerMutationId: string,
): boolean {
  if (!/^change-summary-report-/i.test(ownerMutationId.trim())) return true;
  return role ? canSubmitChangeSummaryReportForRole(role) : false;
}

export type AccessLoginAccountType =
  | 'editor'
  | 'admin'
  | 'inventory_admin'
  | 'building_admin'
  | 'purchase_admin'
  | 'purchase_applicant'
  | 'construction_admin';

export interface AccessPrincipal {
  impersonation?: { actorAccountId: string; actorName: string; targetName: string; expiresAt: number };
  role: AccessRole;
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null;
  displayName?: string;
  accountId?: string;
  authorizationVersion?: number;
  specialties?: readonly ProfessionalSpecialty[];
  buildings?: readonly BuildingAdminBuilding[];
  personalRules?: readonly import('./business-permissions').PersonalPermissionRule[];
  effectiveAuthorization?: import('./authorization-profile').EffectiveAuthorization;
  /** 服务端从已匹配的接口生成，前端从当前页面生成；不能使用客户端请求体赋值。 */
  permissionContext?: import('./business-permissions').BusinessPermissionContext;
  /** Server-selected requirements for compound requests, never populated from request bodies. */
  permissionRequirements?: readonly import('./business-permissions').BusinessPermissionContext[];
}

export interface PrivilegedAccessPrincipal extends AccessPrincipal {
  role: Exclude<AccessRole, 'guest'>;
}

export interface FeishuGuestAccessPrincipal extends AccessPrincipal {
  role: 'guest';
  purchaseBuilding: null;
  feishuAppId: string;
}

export interface ManagedGuestAccessPrincipal extends AccessPrincipal {
  role: 'guest';
  purchaseBuilding: null;
  accountId: string;
  authorizationVersion: number;
  displayName: string;
}
export type TrustedAccessPrincipal = PrivilegedAccessPrincipal | FeishuGuestAccessPrincipal | ManagedGuestAccessPrincipal;

export interface AccessCapabilities {
  canEdit: boolean;
  canDelete: boolean;
  canForceRefresh: boolean;
  canAccessContracts: boolean;
}

export interface AccessSessionResponse extends AccessPrincipal {
  pagePaths?: string[];
  pagePermissionsRevision?: number;
  expiresAt: number | null;
  principalFingerprint: string | null;
  capabilities: AccessCapabilities;
}

export interface AccessLoginRequest {
  employeeName?: string;
  accountType?: AccessLoginAccountType;
  purchaseBuilding?: PurchaseAccessBuilding | BuildingAdminBuilding;
  password: string;
}
