import { BUSINESS_ACTION_LABELS, createBusinessPermissionEvaluator, personalPermissionPagePaths, type BusinessAction, type BusinessModule } from '@shared/business-permissions';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import type { RequestedPermission } from '@shared/personnel-permission-request.interface';
import type { PersonalPermissionCatalog } from '@/api/personal-access';

export function permissionRequestLabel(permission: RequestedPermission, catalog: PersonalPermissionCatalog): string {
  if (permission.kind === 'page') return `${catalog.pages.find(page => page.path === permission.path)?.label || '页面'} · 页面查看`;
  const page = catalog.pages.find(page => page.modules.some(module => module.id === permission.module));
  const module = page?.modules.find(module => module.id === permission.module);
  const range = module?.scoped ? ` · ${permission.buildings?.join('、') || '全部楼栋'} · ${permission.specialties?.join('、') || '全部专业'}` : '';
  return `${page?.label || '页面'} / ${module?.label || '功能'} · ${BUSINESS_ACTION_LABELS[permission.action]}${range}`;
}

export function addRequestedPermission(current: RequestedPermission[], next: RequestedPermission): RequestedPermission[] {
  if (current.some(item => JSON.stringify(item) === JSON.stringify(next))) return current;
  if (current.length >= 20) throw new Error('每次最多申请 20 项权限');
  return [...current, next];
}

export type PersonalPermissionPrincipal = AccessPrincipal & { pagePaths?: string[] };
export function personalReadablePages(principal: PersonalPermissionPrincipal): string[] {
  return personalPermissionPagePaths(principal, principal.pagePaths || principal.effectiveAuthorization?.baseline.pages || []);
}

/** Enumerate actual building/specialty pairs; never join unrelated grants into a wider rectangle. */
export function personalActionCoverage(principal: AccessPrincipal, module: BusinessModule, action: BusinessAction, scoped: boolean) {
  const decide = createBusinessPermissionEvaluator(principal);
  const points = scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building, specialty }))) : [{}];
  const evaluated = points.map(point => ({ ...point, ...decide({ module, action, ...point }) }));
  const allowed = evaluated.filter(point => point.allowed);
  const ranges = scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => {
    const specialties = PROFESSIONAL_SPECIALTIES.filter(specialty => allowed.some(point => 'building' in point && point.building === building && 'specialty' in point && point.specialty === specialty));
    return specialties.length ? [`${building} · ${specialties.length === PROFESSIONAL_SPECIALTIES.length ? '全部专业' : specialties.join('、')}`] : [];
  }) : [];
  const sources = [...new Set(allowed.map(point => ({ role: '角色或独立配置', allow: '个人明确允许', deny: '个人明确禁止', none: '未授权' }[point.source])))];
  return { allowed: allowed.length, total: points.length, ranges, sources };
}

export function alreadyOwnsPermission(principal: PersonalPermissionPrincipal, permission: RequestedPermission): boolean {
  if (permission.kind === 'page') return personalReadablePages(principal).includes(permission.path);
  const decide = createBusinessPermissionEvaluator(principal);
  const pageScoped = permission.buildings !== null || permission.specialties !== null;
  if (pageScoped && (!permission.buildings?.length && permission.buildings !== null || !permission.specialties?.length && permission.specialties !== null)) return false;
  return (permission.buildings || BUILDING_ADMIN_BUILDINGS).every(building => (permission.specialties || PROFESSIONAL_SPECIALTIES).every(specialty => decide({ module: permission.module, action: permission.action, building, specialty }).allowed));
}
