import { ConflictException } from '@nestjs/common';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal, type AccessRole } from '../../../shared/access-control.interface';
import type { AuthorizationOverrides, AuthorizationPolicy } from '../../../shared/authorization-profile';
import { BUSINESS_PERMISSION_CATALOG, createBusinessPermissionEvaluator, normalizedBusinessBuildings, validPersonalRules,
  type BusinessAction, type BusinessModule, type BusinessPermissionContext, type BusinessPermissionTarget, type PersonalPermissionRule } from '../../../shared/business-permissions';
import { effectiveAccountPagePaths, effectivePagePaths, pageApiBinding, type RolePageRules } from '../../../shared/page-access';
import { PERMISSION_ROUTE_CLASSIFICATIONS } from '../../../shared/permission-route-classification';
import { normalizeProfessionalScope, PROFESSIONAL_SPECIALTIES } from '../../../shared/professional-access';

// The V1 scoped evaluator had a global unknown-dimension guard. Keep that historical
// migration boundary explicit; do not use the evolving native-role defaults as an oracle.
const legacyScopedModules: readonly BusinessModule[] = ['risk', 'quality', 'alarms', 'equipment_ledger', 'equipment_lifecycle',
  'thresholds', 'patrol', 'exhaust_valves', 'purchase', 'inventory', 'stocktake', 'tools', 'contracts'];
const legacyModules: readonly BusinessModule[] = ['knowledge', 'meetings', 'system_reports', 'monthly_reports', ...legacyScopedModules];
const definition = (module: BusinessModule) => BUSINESS_PERMISSION_CATALOG.find(item => item.id === module)!;
const principalFor = (account: ManagedAccount): AccessPrincipal => ({ role: account.role, purchaseBuilding: account.building,
  buildings: account.buildings, specialties: account.specialties, personalRules: account.personalRules });
const specialtiesFor = (value: unknown) => {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，;；/]/u) : [];
  const normalized = normalizeProfessionalScope(value);
  return normalized.length === parts.length ? normalized : [];
};
function matches(rule: PersonalPermissionRule, target: BusinessPermissionTarget): boolean {
  const buildings = normalizedBusinessBuildings(target.building), specialties = specialtiesFor(target.specialty);
  return rule.module === target.module && rule.actions.includes(target.action) &&
    (rule.buildings === null || buildings.length > 0 && buildings.every(value => rule.buildings!.includes(value))) &&
    (rule.specialties === null || specialties.length > 0 && specialties.every(value => rule.specialties!.includes(value)));
}
function legacyNativeRead(account: ManagedAccount, target: BusinessPermissionTarget): boolean {
  if (account.role === 'admin') return true;
  const buildings = normalizedBusinessBuildings(target.building), specialties = specialtiesFor(target.specialty);
  if (account.role === 'professional_admin' || account.role === 'professional_engineer') {
    if (!specialties.length || !specialties.every(value => account.specialties?.includes(value))) return false;
    return account.role === 'professional_admin' || buildings.length > 0 && buildings.every(value => (account.buildings || [account.building]).includes(value));
  }
  if (account.role === 'editor') return target.module !== 'contracts';
  if (['purchase_admin', 'supply_chain_admin'].includes(account.role)) return ['purchase', 'inventory', 'stocktake', 'contracts', 'tools'].includes(target.module);
  const modules = account.role === 'building_admin' ? ['purchase', 'inventory', 'stocktake', 'tools', 'equipment_ledger', 'risk', 'quality', 'alarms']
    : account.role === 'inventory_admin' ? ['inventory', 'stocktake', 'tools'] : account.role === 'purchase_applicant' ? ['purchase'] : [];
  return modules.includes(target.module) && buildings.length > 0 && buildings.every(value => (account.buildings || [account.building]).includes(value));
}
/** Only the original scoped read modules are accepted by this historical oracle. */
export function legacyScopedReadAllowed(account: ManagedAccount, target: BusinessPermissionTarget): boolean {
  if (target.action !== 'read' || !legacyScopedModules.includes(target.module) || !validPersonalRules(account.personalRules || [])) return false;
  return legacyReadAllowed(account, target);
}
function legacyReadAllowed(account: ManagedAccount, target: BusinessPermissionTarget): boolean {
  const rules = account.personalRules || [], buildings = normalizedBusinessBuildings(target.building), specialties = specialtiesFor(target.specialty);
  if (legacyScopedModules.includes(target.module) && rules.some(rule => rule.module === target.module && rule.actions.includes('read') &&
    (rule.buildings !== null && !buildings.length || rule.specialties !== null && !specialties.length))) return false;
  const points = buildings.length && specialties.length ? buildings.flatMap(building => specialties.map(specialty => ({ ...target, building, specialty }))) : [target];
  return points.every(point => !rules.some(rule => rule.effect === 'deny' && matches(rule, point)) &&
    ((legacyScopedModules.includes(target.module) ? legacyNativeRead(account, point) : ['admin', 'editor', 'professional_admin', 'professional_engineer'].includes(account.role)) ||
      rules.some(rule => rule.effect === 'allow' && matches(rule, point))));
}
export function legacyAuthorizationPages(account: ManagedAccount, rolePages?: RolePageRules): string[] {
  const pages = new Set(effectiveAccountPagePaths(account.role, rolePages, account.pagePaths));
  for (const page of new Set(legacyModules.map(module => definition(module).page))) {
    const modules = legacyModules.filter(module => definition(module).page === page);
    if (!modules.some(module => account.personalRules?.some(rule => rule.module === module && rule.actions.includes('read')))) continue;
    if (modules.some(module => BUILDING_ADMIN_BUILDINGS.some(building => PROFESSIONAL_SPECIALTIES.some(specialty =>
      legacyReadAllowed(account, { module, action: 'read', building, specialty }))))) pages.add(page);
    else pages.delete(page);
  }
  return [...pages];
}
interface BoundContext extends BusinessPermissionContext { bindings: (readonly string[] | undefined)[]; }
const boundContexts: BoundContext[] = (() => {
  const result = new Map<string, BoundContext>();
  for (const route of PERMISSION_ROUTE_CLASSIFICATIONS) {
    const primary = route.kind === 'business' ? route.permission : route.kind === 'auxiliary' ? route.refreshPermission : undefined;
    if (!primary) continue;
    const path = route.path.replace(/:([A-Za-z]+)/gu, (_, name: string) => name === 'year' ? '2026' : ['month', 'page', 'index'].includes(name) ? '1' : 'synthetic');
    const binding = pageApiBinding(path)?.pages;
    // A forced business GET still requires its original read/selector permission.
    // That requirement preserves a hidden page; do not invent a global refresh deny
    // that also disables an unrelated, historically unbound refresh command.
    const permissions = route.selectorPermissions || (route.recordDependent?.candidateActions || route.selectorActions || [primary.action])
      .map(action => ({ module: primary.module, action }));
    for (const permission of permissions) {
      if (!(definition(permission.module).actions as readonly string[]).includes(permission.action)) continue;
      const key = `${permission.module}:${permission.action}`, context = result.get(key) || { ...permission, bindings: [] };
      context.bindings.push(binding); result.set(key, context);
    }
  }
  return [...result.values()];
})();
function pageGate(context: BoundContext, pages: readonly string[]): 'open' | 'closed' | 'mixed' {
  const values = context.bindings.map(binding => !binding || binding.some(page => pages.includes(page)));
  return values.every(Boolean) ? 'open' : values.every(value => !value) ? 'closed' : 'mixed';
}
const pageDenyId = (module: BusinessModule) => `migration-page-${module}`;
/** These are visible template defaults, so a later personal action allow can override them. */
export function legacyAuthorizationPolicy(role: AccessRole, rolePages?: RolePageRules): AuthorizationPolicy {
  const pages = effectivePagePaths(role, rolePages), rules: PersonalPermissionRule[] = [];
  if (role !== 'admin' && rolePages?.[role] !== undefined) {
    for (const context of boundContexts.filter(item => pageGate(item, pages) === 'closed')) {
      let rule = rules.find(item => item.module === context.module);
      if (!rule) { rule = { id: pageDenyId(context.module), effect: 'deny', module: context.module, actions: [], buildings: null, specialties: null }; rules.push(rule); }
      rule.actions.push(context.action);
    }
  }
  return { nativeRole: role, pages, rules };
}
const subsets = <T>(values: readonly T[]): T[][] => Array.from({ length: 2 ** values.length - 1 }, (_, mask) => values.filter((_, bit) => ((mask + 1) & (1 << bit)) !== 0));
const knownPoints = BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building, specialty })));
const boundaryPoints = [...subsets(BUILDING_ADMIN_BUILDINGS).map(building => ({ building, specialty: undefined })),
  ...subsets(PROFESSIONAL_SPECIALTIES).map(specialty => ({ building: undefined, specialty })), { building: undefined, specialty: undefined }];
export interface LegacyMigrationCheck { module: BusinessModule; action: BusinessAction; checkedTargets: number; equivalent: true; }
export interface LegacyMigrationConflict { code: 'LEGACY_AUTHORIZATION_MIGRATION_CONFLICT'; accountId: string; module?: BusinessModule; action?: BusinessAction; reason: string; target?: { building?: unknown; specialty?: unknown }; beforeAllowed?: boolean; afterAllowed?: boolean; }
function conflict(account: ManagedAccount, reason: string, details: Omit<Partial<LegacyMigrationConflict>, 'code' | 'accountId' | 'reason'> = {}): never {
  throw new ConflictException({ code: 'LEGACY_AUTHORIZATION_MIGRATION_CONFLICT', accountId: account.id, reason,
    message: `旧权限无法安全迁移：${reason}，请先核对该账号的页面和范围规则`, ...details });
}
function addRule(account: ManagedAccount, rules: PersonalPermissionRule[], value: Omit<PersonalPermissionRule, 'id'>): void {
  let id = `migration-${value.module}-${value.actions[0]}-${value.effect}`, suffix = 0;
  while (rules.some(rule => rule.id === id)) id = `migration-${value.module}-${value.actions[0]}-${value.effect}-${++suffix}`;
  if (rules.length >= 100) conflict(account, '保留原规则后需要超过 100 条范围规则');
  rules.push({ id, ...value });
}
function addKnownDeltas(account: ManagedAccount, overrides: AuthorizationOverrides, context: BusinessPermissionContext,
  before: (target: BusinessPermissionTarget) => boolean, after: (target: BusinessPermissionTarget) => boolean): void {
  if (!definition(context.module).scoped) {
    const desired = before(context);
    if (desired !== after(context)) addRule(account, overrides.rules, { module: context.module, actions: [context.action], effect: desired ? 'allow' : 'deny', buildings: null, specialties: null });
    return;
  }
  for (const effect of ['allow', 'deny'] as const) {
    const groups = new Map<string, { buildings: typeof BUILDING_ADMIN_BUILDINGS[number][]; specialties: typeof PROFESSIONAL_SPECIALTIES[number][] }>();
    for (const building of BUILDING_ADMIN_BUILDINGS) {
      const specialties = PROFESSIONAL_SPECIALTIES.filter(specialty => {
        const target = { ...context, building, specialty }, desired = before(target);
        return desired === (effect === 'allow') && desired !== after(target);
      });
      if (!specialties.length) continue;
      const key = specialties.join(','), group = groups.get(key) || { buildings: [], specialties };
      group.buildings.push(building); groups.set(key, group);
    }
    for (const group of groups.values()) addRule(account, overrides.rules, { module: context.module, actions: [context.action], effect, ...group });
  }
}
/** Build on a copy; every difference is either visible and verified or an explicit conflict. */
export function legacyAuthorizationOverrides(account: ManagedAccount, baseline: AuthorizationPolicy, rolePages?: RolePageRules): { overrides: AuthorizationOverrides; checks: LegacyMigrationCheck[] } {
  if (!validPersonalRules(account.personalRules || [])) conflict(account, '旧个人规则无效');
  const scoped = (module: BusinessModule) => legacyScopedModules.includes(module) &&
    (['professional_admin', 'professional_engineer'].includes(account.role) || !!account.personalRules?.some(rule => rule.module === module));
  const overrides: AuthorizationOverrides = { rules: structuredClone(account.personalRules || []), denyPages: [],
    allowPages: account.role === 'admin' ? [] : (account.pagePaths || []).filter(page => !legacyScopedModules.some(module => definition(module).page === page && scoped(module))) };
  if (account.role === 'admin') return { overrides, checks: [] };
  const pages = legacyAuthorizationPages(account, rolePages), configured = rolePages?.[account.role] !== undefined || !!account.pagePaths?.length || account.role === 'guest';
  const principal = principalFor(account), checks: LegacyMigrationCheck[] = [];
  const evaluator = (policy = baseline) => createBusinessPermissionEvaluator({ ...principal,
    effectiveAuthorization: { mode: 'independent', baseline: policy, overrides } });
  const contexts = new Map<string, BoundContext>(boundContexts.map(context => [`${context.module}:${context.action}`, context]));
  for (const module of legacyScopedModules.filter(scoped)) if (!contexts.has(`${module}:read`)) contexts.set(`${module}:read`, { module, action: 'read', bindings: [] });
  for (const context of contexts.values()) {
    const gate = configured && context.bindings.length ? pageGate(context, pages) : 'open';
    const scopedRead = context.action === 'read' && scoped(context.module);
    const templateDenied = baseline.rules.some(rule => rule.id === pageDenyId(context.module) && rule.actions.includes(context.action));
    if (!scopedRead && gate === 'open' && !templateDenied) continue;
    const targets: BusinessPermissionTarget[] = definition(context.module).scoped ? [...knownPoints, ...boundaryPoints].map(point => ({ ...context, ...point })) : [context];
    const current = evaluator();
    if (gate === 'mixed') {
      if (targets.some(target => current(target).allowed || scopedRead && legacyScopedReadAllowed(account, target)))
        conflict(account, '同一动作的旧接口页面限制不同，不能合并为一个范围规则', { module: context.module, action: context.action });
      continue;
    }
    const withoutPageDeny = evaluator({ ...baseline, rules: baseline.rules.filter(rule => rule.id !== pageDenyId(context.module)) });
    const desired = (target: BusinessPermissionTarget) => gate === 'closed' ? false : scopedRead ? legacyScopedReadAllowed(account, target) : withoutPageDeny(target).allowed;
    if (targets.every(target => !desired(target)) && targets.some(target => current(target).allowed)) {
      addRule(account, overrides.rules, { module: context.module, actions: [context.action], effect: 'deny', buildings: null, specialties: null });
    } else if (targets.every(desired) && targets.some(target => !current(target).allowed)) {
      addRule(account, overrides.rules, { module: context.module, actions: [context.action], effect: 'allow', buildings: null, specialties: null });
    } else addKnownDeltas(account, overrides, context, desired, target => current(target).allowed);
    const migrated = evaluator();
    for (const target of targets) {
      const beforeAllowed = desired(target), afterAllowed = migrated(target).allowed;
      if (beforeAllowed !== afterAllowed) conflict(account, '缺少楼栋或专业时的旧范围无法准确表达', {
        module: context.module, action: context.action, target: { building: target.building, specialty: target.specialty }, beforeAllowed, afterAllowed });
    }
    checks.push({ module: context.module, action: context.action, checkedTargets: targets.length, equivalent: true });
  }
  return { overrides, checks };
}
