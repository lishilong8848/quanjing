import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal, type BuildingAdminBuilding } from './access-control.interface';
import { normalizeProfessionalScope, PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from './professional-access';
import { validBuildingScope } from './building-access';

export const BUSINESS_ACTION_LABELS = {
  read: '查看', create: '新增', update: '修改', delete: '删除', approve: '审批',
  order: '下单', receive: '收货', confirm: '确认', export: '导出/下载', refresh: '刷新数据',
} as const;
export type BusinessAction = keyof typeof BUSINESS_ACTION_LABELS;
const reading = ['read', 'export', 'refresh'] as const;
const editing = ['read', 'create', 'update', 'delete', 'export', 'refresh'] as const;
export const BUSINESS_PERMISSION_CATALOG = [
  { id: 'knowledge', label: '运维知识库', page: '/operations-kb', scoped: false, actions: editing },
  { id: 'meetings', label: '议事航迹', page: '/meeting-management', scoped: false, actions: editing },
  { id: 'system_reports', label: '体系月报', page: '/system-monthly-report', scoped: false, actions: [...editing, 'approve'] },
  { id: 'monthly_reports', label: '月度报告', page: '/ali-monthly-report', scoped: false, actions: editing },
  { id: 'risk', label: '风险排查', page: '/risk-inspection-dashboard', scoped: true, actions: ['read', 'update', 'export', 'refresh'] },
  { id: 'quality', label: '质量评估', page: '/quality-assessment', scoped: true, actions: ['read', 'update', 'export', 'refresh'] },
  { id: 'alarms', label: '月度告警', page: '/monthly-alarm-overview', scoped: true, actions: reading },
  { id: 'equipment_ledger', label: '设备台账', page: '/equipment-ledger-management', scoped: true, actions: reading },
  { id: 'equipment_lifecycle', label: '设备全生命周期', page: '/equipment-lifecycle-dashboard', scoped: true, actions: reading },
  { id: 'thresholds', label: '阈值管理', page: '/threshold-management', scoped: true, actions: ['read', 'create', 'update', 'export', 'refresh'] },
  { id: 'patrol', label: '巡检管理', page: '/equipment-patrol-dashboard', scoped: true, actions: reading },
  { id: 'exhaust_valves', label: '排气阀定位', page: '/exhaust-valve-map', scoped: true, actions: reading },
  { id: 'purchase', label: '采购管理', page: '/purchase-inventory-management', scoped: true, actions: [...editing, 'approve', 'order', 'receive'] },
  { id: 'inventory', label: '库存与出入库', page: '/inventory-management', scoped: true, actions: [...editing, 'confirm'] },
  { id: 'stocktake', label: '库存盘点', page: '/inventory-management', scoped: true, actions: [...editing, 'confirm'] },
  { id: 'tools', label: '运维工具', page: '/operations-tools-management', scoped: true, actions: reading },
  { id: 'contracts', label: '合同管理', page: '/contract-management', scoped: true, actions: [...editing, 'confirm'] },
] as const;
export type BusinessModule = typeof BUSINESS_PERMISSION_CATALOG[number]['id'];
export interface BusinessPermissionContext { module: BusinessModule; action: BusinessAction; }
export interface PersonalPermissionRule {
  id: string;
  effect: 'allow' | 'deny';
  module: BusinessModule;
  actions: BusinessAction[];
  /** null 为明确选择全部；空数组不合法。每行范围独立，不跨行求笛卡尔积。 */
  buildings: BuildingAdminBuilding[] | null;
  specialties: ProfessionalSpecialty[] | null;
}
type PolicyPrincipal = Pick<AccessPrincipal, 'role' | 'specialties'> & Partial<Pick<AccessPrincipal, 'purchaseBuilding' | 'buildings' | 'personalRules' | 'permissionContext'>>;
export interface BusinessPermissionTarget extends BusinessPermissionContext { building?: unknown; specialty?: unknown; }
export interface BusinessPermissionDecision { allowed: boolean; source: 'deny' | 'allow' | 'role' | 'none'; }

export function businessModuleDefinition(module: BusinessModule) {
  return BUSINESS_PERMISSION_CATALOG.find(item => item.id === module)!;
}
function validSelection(value: unknown, options: readonly string[]): boolean {
  return value === null || (Array.isArray(value) && value.length > 0 && value.length <= options.length &&
    value.every(item => typeof item === 'string' && options.includes(item)) && new Set(value).size === value.length);
}
export function validPersonalRules(value: unknown): value is PersonalPermissionRule[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  return value.every(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
      Object.keys(rule).sort().join(',') !== 'actions,buildings,effect,id,module,specialties' ||
      typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id) || !['allow', 'deny'].includes(rule.effect)) return false;
    ids.add(rule.id);
    const definition = BUSINESS_PERMISSION_CATALOG.find(item => item.id === rule.module);
    return !!definition && Array.isArray(rule.actions) && rule.actions.length > 0 && rule.actions.length <= definition.actions.length &&
      rule.actions.every((action: unknown) => typeof action === 'string' && (definition.actions as readonly string[]).includes(action)) && new Set(rule.actions).size === rule.actions.length &&
      validSelection(rule.buildings, BUILDING_ADMIN_BUILDINGS) && validSelection(rule.specialties, PROFESSIONAL_SPECIALTIES) &&
      (definition.scoped || (rule.buildings === null && rule.specialties === null));
  });
}
export function isProfessionalBusinessPrincipal<T extends Pick<AccessPrincipal, 'role' | 'personalRules' | 'permissionContext'>>(principal: T | undefined): principal is T & ({ role: 'professional_admin' | 'professional_engineer' } | { personalRules: readonly PersonalPermissionRule[] }) {
  return !!principal && (principal.role === 'professional_admin' || principal.role === 'professional_engineer' || !!principal.personalRules?.some(rule => !principal.permissionContext || rule.module === principal.permissionContext.module));
}
export function normalizedBusinessBuildings(value: unknown): BuildingAdminBuilding[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，;；/]/u) : [];
  const normalized = parts.map(item => typeof item === 'string' ? item.trim().replace(/^([abcdeh])楼$/i, (_, letter: string) => `${letter.toUpperCase()}楼`).replace(/^(?:110kV变电站|110KV站|110站|110kV站)$/i, '110站') : '');
  return normalized.length && normalized.every(item => (BUILDING_ADMIN_BUILDINGS as readonly string[]).includes(item))
    ? [...new Set(normalized)] as BuildingAdminBuilding[] : [];
}
export function businessBuildingLabels(value: string): BuildingAdminBuilding[] {
  const matches = value.match(/[A-Za-z]楼|110(?:kV变电站|KV站|kV站|站)/gu) || [];
  return normalizedBusinessBuildings(matches);
}
function validTargetSpecialties(value: unknown): ProfessionalSpecialty[] {
  const normalized = normalizeProfessionalScope(value);
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，;；/]/u) : [];
  return normalized.length && normalized.length === parts.length ? normalized : [];
}
function ruleMatches(rule: PersonalPermissionRule, target: BusinessPermissionTarget): boolean {
  if (rule.module !== target.module || !rule.actions.includes(target.action)) return false;
  const buildings = normalizedBusinessBuildings(target.building), specialties = validTargetSpecialties(target.specialty);
  return (rule.buildings === null || (buildings.length > 0 && buildings.every(value => rule.buildings!.includes(value)))) &&
    (rule.specialties === null || (specialties.length > 0 && specialties.every(value => rule.specialties!.includes(value))));
}
function roleDefault(principal: PolicyPrincipal, target: BusinessPermissionTarget): boolean {
  if (principal.role === 'admin') return true;
  const definition = businessModuleDefinition(target.module);
  if (principal.role === 'professional_admin' || principal.role === 'professional_engineer') {
    if (!definition.scoped) return true;
    const specialties = validTargetSpecialties(target.specialty);
    if (!specialties.length || !specialties.every(value => principal.specialties?.includes(value))) return false;
    if (principal.role === 'professional_admin') return true;
    const buildings = normalizedBusinessBuildings(target.building);
    return !!buildings.length && buildings.every(value => (principal.buildings || [principal.purchaseBuilding]).includes(value));
  }
  const supply = ['purchase', 'inventory', 'stocktake', 'contracts', 'tools'].includes(target.module);
  if (principal.role === 'editor') return target.module !== 'contracts' && !['delete', 'approve', 'order'].includes(target.action);
  if (['purchase_admin', 'supply_chain_admin'].includes(principal.role)) return supply;
  if (['building_admin', 'inventory_admin', 'purchase_applicant'].includes(principal.role)) {
    const modules = principal.role === 'building_admin' ? ['purchase', 'inventory', 'stocktake', 'tools', 'equipment_ledger', 'risk', 'quality', 'alarms'] : principal.role === 'inventory_admin' ? ['inventory', 'stocktake', 'tools'] : ['purchase'];
    const buildings = normalizedBusinessBuildings(target.building);
    return modules.includes(target.module) && !!buildings.length && buildings.every(value => (principal.buildings || [principal.purchaseBuilding]).includes(value));
  }
  return false;
}
export function decideBusinessPermission(principal: PolicyPrincipal, target: BusinessPermissionTarget): BusinessPermissionDecision {
  const definition = BUSINESS_PERMISSION_CATALOG.find(item => item.id === target.module);
  if (!definition || !(definition.actions as readonly string[]).includes(target.action) ||
    (principal.personalRules !== undefined && !validPersonalRules(principal.personalRules))) return { allowed: false, source: 'none' };
  const rules = principal.personalRules || [];
  const matching = rules.filter(rule => ruleMatches(rule, target));
  // 多专业/跨楼记录必须逐个组合可操作，任一限制生效即拒绝整条记录。
  const buildings = normalizedBusinessBuildings(target.building), specialties = validTargetSpecialties(target.specialty);
  if (definition.scoped && rules.some(rule => rule.module === target.module && rule.actions.includes(target.action) && ((rule.buildings !== null && !buildings.length) || (rule.specialties !== null && !specialties.length)))) return { allowed: false, source: 'none' };
  const points = definition.scoped && buildings.length && specialties.length ? buildings.flatMap(building => specialties.map(specialty => ({ ...target, building, specialty }))) : [target];
  if (points.some(point => rules.some(rule => rule.effect === 'deny' && ruleMatches(rule, point)))) return { allowed: false, source: 'deny' };
  if (points.every(point => roleDefault(principal, point) || rules.some(rule => rule.effect === 'allow' && ruleMatches(rule, point)))) {
    return { allowed: true, source: matching.some(rule => rule.effect === 'allow') || !roleDefault(principal, target) ? 'allow' : 'role' };
  }
  return { allowed: false, source: 'none' };
}
export function canPerformBusinessAction(principal: PolicyPrincipal, target: BusinessPermissionTarget): boolean {
  return decideBusinessPermission(principal, target).allowed;
}
export function hasBusinessPermissionSomewhere(principal: PolicyPrincipal, context: BusinessPermissionContext): boolean {
  if (!businessModuleDefinition(context.module).scoped) return canPerformBusinessAction(principal, context);
  return BUILDING_ADMIN_BUILDINGS.some(building => PROFESSIONAL_SPECIALTIES.some(specialty => canPerformBusinessAction(principal, { ...context, building, specialty })));
}
export function businessModuleForPage(path: string): BusinessModule | undefined {
  return BUSINESS_PERMISSION_CATALOG.find(item => path === item.page || path.startsWith(`${item.page}/`))?.id;
}
export function personalPermissionPagePaths(principal: AccessPrincipal, inherited: readonly string[]): string[] {
  if (!principal.personalRules?.length) return [...inherited];
  const result = new Set(inherited);
  for (const page of new Set(BUSINESS_PERMISSION_CATALOG.map(item => item.page))) {
    const definitions = BUSINESS_PERMISSION_CATALOG.filter(item => item.page === page);
    if (!definitions.some(item => principal.personalRules!.some(rule => rule.module === item.id && rule.actions.includes('read')))) continue;
    if (definitions.some(item => hasBusinessPermissionSomewhere(principal, { module: item.id, action: 'read' }))) result.add(page);
    else result.delete(page);
  }
  return [...result];
}
export function businessPermissionScopeKey(principal: AccessPrincipal): string {
  return JSON.stringify([principal.accountId, principal.authorizationVersion, principal.role, principal.purchaseBuilding, principal.buildings, principal.specialties, principal.personalRules]);
}
export function businessAuthorizationSnapshot(principal: AccessPrincipal): AccessPrincipal {
  return structuredClone({ role: principal.role, purchaseBuilding: principal.purchaseBuilding,
    ...(principal.buildings ? { buildings: principal.buildings } : {}), ...(principal.specialties ? { specialties: principal.specialties } : {}),
    ...(principal.personalRules ? { personalRules: principal.personalRules } : {}), ...(principal.permissionContext ? { permissionContext: principal.permissionContext } : {}),
    ...(principal.accountId ? { accountId: principal.accountId } : {}), ...(principal.authorizationVersion !== undefined ? { authorizationVersion: principal.authorizationVersion } : {}),
    ...(principal.displayName ? { displayName: principal.displayName } : {}) });
}
export function validScopedBusinessPrincipal(value: unknown): value is AccessPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as AccessPrincipal;
  if ((principal.authorizationVersion !== undefined && (!Number.isSafeInteger(principal.authorizationVersion) || principal.authorizationVersion < 1)) || (principal.permissionContext !== undefined && !BUSINESS_PERMISSION_CATALOG.some(item => item.id === principal.permissionContext!.module && (item.actions as readonly string[]).includes(principal.permissionContext!.action))) || !isProfessionalBusinessPrincipal(principal) || !validBuildingScope(principal.role, principal.purchaseBuilding, principal.buildings) || !principal.accountId ||
    (principal.personalRules !== undefined && !validPersonalRules(principal.personalRules))) return false;
  if (principal.role === 'professional_admin' || principal.role === 'professional_engineer') return Array.isArray(principal.specialties) && principal.specialties.length > 0 &&
    principal.specialties.every(value => PROFESSIONAL_SPECIALTIES.includes(value)) && new Set(principal.specialties).size === principal.specialties.length;
  return !!principal.personalRules?.length;
}
export function businessBuildingsForAction(principal: PolicyPrincipal, context: BusinessPermissionContext): BuildingAdminBuilding[] {
  return BUILDING_ADMIN_BUILDINGS.filter(building => PROFESSIONAL_SPECIALTIES.some(specialty => canPerformBusinessAction(principal, { ...context, building, specialty })));
}
