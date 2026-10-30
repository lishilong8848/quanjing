import { BUILDING_ADMIN_BUILDINGS, type BuildingAdminBuilding } from './access-control.interface';
import { BUSINESS_PERMISSION_CATALOG, configurableBusinessActions, type BusinessAction, type BusinessModule } from './business-permissions';
import { createPermissionCatalog } from './permission-catalog';
import { PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from './professional-access';

export type RequestedPermission =
  | { kind: 'page'; path: string }
  | { kind: 'action'; module: BusinessModule; action: BusinessAction; buildings: BuildingAdminBuilding[] | null; specialties: ProfessionalSpecialty[] | null };

export interface CreatePersonnelPermissionRequest {
  clientMutationId: string;
  permissions: RequestedPermission[];
  reason: string;
}

export interface ReviewPersonnelPermissionRequest {
  clientMutationId: string;
  requestId: string;
  expectedRequestVersion: number;
  decision: 'approve' | 'reject';
  comment?: string;
}

export interface UpdatePersonnelPermissionRequest {
  clientMutationId: string;
  requestId: string;
  expectedRequestVersion: number;
  reason: string;
}
export type CancelPersonnelPermissionRequest = Omit<UpdatePersonnelPermissionRequest, 'reason'>;
export interface PersonnelRequestCapacity {
  level: 'normal' | 'warning' | 'full';
  bytes: number; maxBytes: number;
  requests: number; maxRequests: number;
  mutations: number; maxMutations: number;
  auditEntries: number; maxAuditEntries: number;
}
export interface PersonnelPermissionRequestSummary {
  total: number; pending: number; approved: number; rejected: number; cancelled: number;
  capacity: PersonnelRequestCapacity;
}

export interface PersonnelPermissionRequest {
  id: string;
  version: number;
  accountId: string;
  applicantName: string;
  permissions: RequestedPermission[];
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  reviewerAccountId?: string;
  reviewerName?: string;
  comment?: string;
  verifiedConfigurationRevision?: number;
  /** Read-only current permission check; does not imply approval duties or document-state eligibility. */
  currentEffect?: 'current' | 'partial' | 'none' | 'unavailable';
  currentEffectRevision?: number | null;
}

const localPages = new Set(createPermissionCatalog().pages.filter(page => page.kind !== 'external').map(page => page.path));
function selection(value: unknown, options: readonly string[]): boolean {
  return value === null || (Array.isArray(value) && value.length > 0 && value.length <= options.length &&
    value.every(item => typeof item === 'string' && options.includes(item)) && new Set(value).size === value.length);
}

/** Only real local page entries and actions can be requested. Public/fixed-admin endpoints are never grants. */
export function validRequestedPermissions(value: unknown): value is RequestedPermission[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) return false;
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (item.kind === 'page') return Object.keys(item).sort().join(',') === 'kind,path' && localPages.has(item.path);
    if (item.kind !== 'action' || Object.keys(item).sort().join(',') !== 'action,buildings,kind,module,specialties') return false;
    const definition = BUSINESS_PERMISSION_CATALOG.find(module => module.id === item.module);
    return !!definition && localPages.has(definition.page) && configurableBusinessActions(definition.id).includes(item.action) &&
      selection(item.buildings, BUILDING_ADMIN_BUILDINGS) && selection(item.specialties, PROFESSIONAL_SPECIALTIES) &&
      (definition.scoped || (item.buildings === null && item.specialties === null));
  });
}

export function canonicalRequestedPermissions(value: RequestedPermission[]): RequestedPermission[] {
  const items = value.map(item => item.kind === 'page' ? { kind: 'page' as const, path: item.path } : {
    kind: 'action' as const, module: item.module, action: item.action,
    buildings: item.buildings === null ? null : BUILDING_ADMIN_BUILDINGS.filter(building => item.buildings!.includes(building)),
    specialties: item.specialties === null ? null : PROFESSIONAL_SPECIALTIES.filter(specialty => item.specialties!.includes(specialty)),
  });
  return [...new Map(items.map(item => [JSON.stringify(item), item])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}
