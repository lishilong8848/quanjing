import { businessModulesForPage, hasBusinessPermissionSomewhere, isProfessionalBusinessPrincipal } from '@shared/business-permissions';
import { canReadPage, validPagePaths, effectivePagePaths } from '@shared/page-access';
import { canAccessBuilding } from '@shared/building-access';
import type {
  AccessCapabilities,
  AccessLoginAccountType,
  AccessPrincipal,
  AccessRole,
  AccessSessionResponse,
  BuildingAdminBuilding,
  PurchaseAccessBuilding,
} from '@shared/access-control.interface';
import type { PurchaseInventoryRequestItem } from '@shared/purchase-inventory.interface';
import { canManageProfessionalRecord } from '@shared/professional-access';

const PROFESSIONAL_PAGES = new Set(['/operations-kb', '/meeting-management', '/system-monthly-report', '/ali-monthly-report', '/risk-inspection-dashboard', '/quality-assessment', '/monthly-alarm-overview', '/equipment-lifecycle-dashboard', '/equipment-ledger-management', '/threshold-management', '/equipment-patrol-dashboard', '/exhaust-valve-map', '/purchase-inventory-management', '/inventory-management', '/operations-tools-management', '/contract-management']);
export function professionalPageCapabilities(pathname: string, principal?: AccessPrincipal): AccessCapabilities {
  const path = normalizePagePath(pathname);
  const allowed = [...PROFESSIONAL_PAGES].some(page => path === page || path.startsWith(`${page}/`));
  const modules = businessModulesForPage(path);
  if (principal && modules.length) return { canEdit: modules.some(module => ['create', 'update', 'approve', 'order', 'receive', 'confirm'].some(action => hasBusinessPermissionSomewhere(principal, { module, action: action as never }))), canDelete: modules.some(module => hasBusinessPermissionSomewhere(principal, { module, action: 'delete' })), canForceRefresh: modules.some(module => hasBusinessPermissionSomewhere(principal, { module, action: 'refresh' })), canAccessContracts: hasBusinessPermissionSomewhere(principal, { module: 'contracts', action: 'read' }) };
  return { canEdit: allowed, canDelete: allowed, canForceRefresh: allowed, canAccessContracts: allowed };
}

import {
  PURCHASE_INVENTORY_MANAGEMENT_PATH,
  isPurchaseApplicationDirectPath,
} from '../navigation/purchase-application-route';

const GUEST_PAGES = new Set([
  '/monthly-schedule',
  '/mbti-assessment',
  '/monthly-schedule/apply/leave',
  '/monthly-schedule/apply/overtime',
  '/today-operations-panorama',
  '/monthly-operations',
  '/nantong-base',
  '/system-monthly-report',
]);
const MONTHLY_SCHEDULE_PAGE = '/monthly-schedule';
const CONSTRUCTION_MANAGEMENT_PAGE = '/construction-management';
const CONTRACT_MANAGEMENT_PAGE = '/contract-management';
const INVENTORY_MANAGEMENT_PAGE = '/inventory-management';
const OPERATIONS_TOOLS_PAGE = '/operations-tools-management';
const CAMPUS_OPERATIONS_DASHBOARD_PAGE = '/campus-operations-dashboard';
const UNIFIED_LOGIN_ACCOUNT_TYPES = [
  'admin',
  'editor',
  'inventory_admin',
  'building_admin',
  'purchase_admin',
  'purchase_applicant',
  'construction_admin',
] as const satisfies readonly AccessLoginAccountType[];
const POST_DELETE_PATHS = new Set([
  '/api/purchase-inventory/records/batch-delete',
  '/api/duty-schedules/construction-management/attachments/delete',
  '/api/duty-schedules/construction-management/projects/delete',
  '/api/duty-schedules/exception-follow-up/delete',
  '/api/duty-schedules/travel-staff/revoke',
]);

export function canAccessPage(role: AccessRole, pathname: string, pagePaths?: readonly string[]): boolean {
  return canReadPage(role, pathname, pagePaths);
}

export function isControlledScreenshotPageRequest(
  pathname: string,
  search: string,
): boolean {
  if (normalizePagePath(pathname) !== CAMPUS_OPERATIONS_DASHBOARD_PAGE) {
    return false;
  }

  const params = new URLSearchParams(search);
  const screenshotDate = params.get('screenshotDate') || '';
  const screenshotShift = params.get('screenshotShift') || '';
  const screenshotToken = params.get('screenshotToken') || '';
  return (
    params.get('screenshot') === '1' &&
    /^\d{4}-\d{2}-\d{2}$/.test(screenshotDate) &&
    (screenshotShift === 'white' || screenshotShift === 'night') &&
    screenshotToken.length > 0 &&
    screenshotToken.length <= 512
  );
}

export function getUnifiedLoginAccountTypes(): readonly AccessLoginAccountType[] {
  return UNIFIED_LOGIN_ACCOUNT_TYPES;
}

export interface ReauthenticationLoginDefaults {
  accountType: AccessLoginAccountType | '';
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | '';
}

export function getReauthenticationLoginDefaults(
  principal: AccessPrincipal,
): ReauthenticationLoginDefaults {
  const accountType =
    UNIFIED_LOGIN_ACCOUNT_TYPES.find(
      (candidate) => candidate === principal.role,
    ) || '';
  const requiresBuilding =
    accountType === 'inventory_admin' || accountType === 'purchase_applicant' || accountType === 'building_admin';

  return {
    accountType,
    purchaseBuilding:
      requiresBuilding && principal.purchaseBuilding
        ? principal.purchaseBuilding
        : '',
  };
}

function defaultPostLoginPath(
  role: AccessRole,
  currentPath: string,
): string {
  if (role === 'inventory_admin' || role === 'building_admin') {
    return canAccessPage(role, currentPath)
      ? normalizePagePath(currentPath)
      : INVENTORY_MANAGEMENT_PAGE;
  }
  const normalizedCurrentPath = normalizePagePath(currentPath);
  if (role === 'purchase_admin') {
    return canAccessPage(role, normalizedCurrentPath)
      ? normalizedCurrentPath
      : PURCHASE_INVENTORY_MANAGEMENT_PATH;
  }
  if (role === 'purchase_applicant') {
    return isPurchaseApplicationDirectPath(normalizedCurrentPath)
      ? normalizedCurrentPath
      : PURCHASE_INVENTORY_MANAGEMENT_PATH;
  }
  if (role === 'duty_editor') return MONTHLY_SCHEDULE_PAGE;
  if (role === 'construction_admin') return CONSTRUCTION_MANAGEMENT_PAGE;

  if (role === 'supply_chain_admin') {
    return canAccessPage(role, normalizedCurrentPath)
      ? normalizedCurrentPath
      : PURCHASE_INVENTORY_MANAGEMENT_PATH;
  }
  if (role === 'admin' || canAccessPage(role, normalizedCurrentPath)) {
    return normalizedCurrentPath;
  }
  return role === 'guest' ? '/nantong-base' : MONTHLY_SCHEDULE_PAGE;
}

export function getPostLoginPath(role: AccessRole, currentPath: string, pagePaths?: readonly string[]): string {
  const preferred = defaultPostLoginPath(role, currentPath);
  if (pagePaths === undefined) return preferred;
  if (canAccessPage(role, currentPath, pagePaths)) return normalizePagePath(currentPath);
  if (canAccessPage(role, preferred, pagePaths)) return preferred;
  return pagePaths.find(path => path === '/nantong-base') || pagePaths.find(path => path.startsWith('/')) || '/nantong-base';
}

export function capabilitiesForRole(role: AccessRole): AccessCapabilities {
  return {
    canEdit:
      (role === 'professional_admin' || role === 'professional_engineer') ||
      role === 'admin' ||
      role === 'editor' ||
      role === 'inventory_admin' ||
      role === 'building_admin' ||
      role === 'purchase_admin' ||
      role === 'duty_editor' ||
      role === 'supply_chain_admin' ||
      role === 'construction_admin',
    canDelete:
      (role === 'professional_admin' || role === 'professional_engineer') ||
      role === 'admin' ||
      role === 'building_admin' ||
      role === 'purchase_admin' ||
      role === 'supply_chain_admin' ||
      role === 'construction_admin',
    canForceRefresh: role !== 'guest' && role !== 'site_member',
    canAccessContracts:
      (role === 'professional_admin' || role === 'professional_engineer') ||
      role === 'admin' ||
      role === 'purchase_admin' ||
      role === 'supply_chain_admin',
  };
}

type AccessSessionInput = Omit<AccessSessionResponse, 'capabilities'> & {
  capabilities?: AccessCapabilities;
};

export function hasAuthenticatedAccessIdentity(
  session: Pick<AccessSessionResponse, 'role' | 'expiresAt' | 'principalFingerprint'>,
): boolean {
  return session.role !== 'guest' ||
    (session.expiresAt !== null && Boolean(session.principalFingerprint));
}

export function normalizeAccessSession(
  session: AccessSessionInput,
): AccessSessionResponse {
  return {
    ...session,
    pagePaths: session.pagePaths === undefined ? effectivePagePaths(session.role) : validPagePaths(session.pagePaths) ? session.pagePaths : [],
    capabilities: session.capabilities || capabilitiesForRole(session.role),
  };
}

export function canCreatePurchaseApplication(
  principal: AccessPrincipal,
): boolean {
  if (principal.effectiveAuthorization || isProfessionalBusinessPrincipal({...principal,permissionContext:{module:'purchase',action:'create'}})) return hasBusinessPermissionSomewhere(principal,{module:'purchase',action:'create'});
  return (
    isProfessionalBusinessPrincipal(principal) ||
    principal.role === 'building_admin' ||
    principal.role === 'admin' ||
    principal.role === 'editor' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin' ||
    principal.role === 'purchase_applicant'
  );
}

export function canManagePurchaseWorkflow(principal: AccessPrincipal): boolean {
  if (principal.effectiveAuthorization) return (['approve','order','receive'] as const).some(action=>hasBusinessPermissionSomewhere(principal,{module:'purchase',action}));
  return (
    isProfessionalBusinessPrincipal(principal) ||
    principal.role === 'building_admin' ||
    principal.role === 'admin' ||
    principal.role === 'editor' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  );
}

export function canOrderPurchaseRecord(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  if (
    item.stage !== 'executing' ||
    !item.executionRecordId ||
    item.purchaseCompleted
  ) {
    return false;
  }

  if (isProfessionalBusinessPrincipal(principal)) return canManageProfessionalRecord(principal, item.specialty, item.building, { module: 'purchase', action: 'order' });
  if (
    (principal.role === 'building_admin' &&
      canAccessBuilding(principal, item.building)) ||
    principal.role === 'admin' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  ) {
    return true;
  }
  return canApplicantHandleSelfPurchase(principal, item);
}

export function canReceivePurchaseRecord(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  if (item.stage !== 'receiving' || !item.executionRecordId) {
    return false;
  }

  if (isProfessionalBusinessPrincipal(principal)) return canManageProfessionalRecord(principal, item.specialty, item.building, { module: 'purchase', action: 'receive' });
  if (
    (principal.role === 'building_admin' &&
      canAccessBuilding(principal, item.building)) ||
    principal.role === 'admin' ||
    principal.role === 'editor' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  ) {
    return true;
  }
  return canApplicantHandleSameBuilding(principal, item);
}

export function canEditPurchaseRecord(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  if (principal.role !== 'admin' && item.stage === 'rejected') return false;
  if (principal.role === 'purchase_applicant' && !canApplicantMaintainPurchaseRecord(principal,item)) return false;
  if (isProfessionalBusinessPrincipal(principal)) return canManageProfessionalRecord(principal, item.specialty, item.building, { module: 'purchase', action: 'update' });

  if (principal.role === 'admin') return true;
  if (principal.role === 'building_admin') {
    return canAccessBuilding(principal, item.building);
  }
  if (item.stage === 'rejected') return false;
  if (
    principal.role === 'editor' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  ) {
    return true;
  }
  return canApplicantMaintainPurchaseRecord(principal, item);
}

export function canDeletePurchaseRecord(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  if (principal.role === 'editor' && item.stage !== 'stocked') return false;
  if (principal.role === 'purchase_applicant' && !canApplicantMaintainPurchaseRecord(principal,item)) return false;
  if (isProfessionalBusinessPrincipal(principal)) return canManageProfessionalRecord(principal, item.specialty, item.building, { module: 'purchase', action: 'delete' });

  if (
    (principal.role === 'building_admin' &&
      canAccessBuilding(principal, item.building)) ||
    principal.role === 'admin' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  ) {
    return true;
  }
  if (principal.role === 'editor') return item.stage === 'stocked';
  return canApplicantMaintainPurchaseRecord(principal, item);
}

export function canDeleteCompletedPurchaseRecords(
  principal: AccessPrincipal,
): boolean {
  if (principal.effectiveAuthorization) return hasBusinessPermissionSomewhere(principal,{module:'purchase',action:'delete'});
  return (
    isProfessionalBusinessPrincipal(principal) ||
    principal.role === 'building_admin' ||
    principal.role === 'admin' ||
    principal.role === 'editor' ||
    principal.role === 'purchase_admin' ||
    principal.role === 'supply_chain_admin'
  );
}

export function getAccessRoleLabel(
  role: AccessRole,
  purchaseBuilding: PurchaseAccessBuilding | BuildingAdminBuilding | null = null,
  buildings?: readonly BuildingAdminBuilding[],
): string {
  const scopeLabel = buildings?.join('、') || purchaseBuilding;
  if (role === 'site_member') return '基地成员';
  if (role === 'professional_admin') return '专业主管';
  if (role === 'professional_engineer') return '专业工程师';
  if (role === 'admin') return '管理员';
  if (role === 'editor') return '子管理员';
  if (role === 'inventory_admin') {
    return scopeLabel ? `${scopeLabel}库存管理员` : '库存管理员';
  }
  if (role === 'building_admin') {
    return scopeLabel ? `${scopeLabel}楼栋管理员` : '楼栋管理员';
  }
  if (role === 'purchase_admin') return '采购&合同管理员';
  if (role === 'purchase_applicant') {
    return scopeLabel ? `${scopeLabel}采购申请人` : '采购申请人';
  }
  if (role === 'duty_editor') return '排班编辑';
  if (role === 'supply_chain_admin') return '采购与合同管理员';
  if (role === 'construction_admin') return '施工管理员';
  return '游客';
}

export function isPersistedDeleteAction(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return (
    normalizedMethod === 'DELETE' ||
    (normalizedMethod === 'POST' && POST_DELETE_PATHS.has(path))
  );
}

function normalizePagePath(pathname: string): string {
  const value = String(pathname || '/').toLowerCase();
  return value.length > 1 ? value.replace(/\/+$/g, '') || '/' : value;
}

function canApplicantMaintainPurchaseRecord(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  return (
    principal.role === 'purchase_applicant' &&
    canAccessBuilding(principal, item.building) &&
    (item.stage === 'application' || item.stage === 'approval') &&
    !item.purchaseCompleted
  );
}

function canApplicantHandleSelfPurchase(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  return (
    item.purchaseMethod.includes('需求自采') &&
    canApplicantHandleSameBuilding(principal, item)
  );
}

function canApplicantHandleSameBuilding(
  principal: AccessPrincipal,
  item: PurchaseInventoryRequestItem,
): boolean {
  return (
    principal.role === 'purchase_applicant' &&
    canAccessBuilding(principal, item.building)
  );
}

function normalizePurchaseBuilding(
  value: unknown,
): PurchaseAccessBuilding | null {
  if (typeof value !== 'string') return null;
  const match = /^([abcdeh])楼$/i.exec(value.trim());
  return match
    ? (`${match[1].toUpperCase()}楼` as PurchaseAccessBuilding)
    : null;
}
