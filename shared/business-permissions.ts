import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal, type BuildingAdminBuilding } from './access-control.interface';
import { normalizeProfessionalScope, PROFESSIONAL_SPECIALTIES, type ProfessionalSpecialty } from './professional-access';
import { roleBuildingOptions, validBuildingScope } from './building-access';
import { effectivePagePaths, PAGE_ACCESS_ROLES, validPagePaths } from './page-access';
import type { AuthorizationBasePolicy, AuthorizationOverrides, EffectiveAuthorization } from './authorization-profile';
import { PERMISSION_ROUTE_CLASSIFICATIONS } from './permission-route-classification';

export const BUSINESS_ACTION_LABELS = {
  read: '查看', create: '新增', update: '修改', delete: '删除', approve: '审批',
  order: '下单', receive: '收货', confirm: '确认', export: '导出/下载', refresh: '刷新数据', notify:'手动通知',
} as const;
export type BusinessAction = keyof typeof BUSINESS_ACTION_LABELS;
const reading = ['read', 'export', 'refresh'] as const;
const editing = ['read', 'create', 'update', 'delete', 'export', 'refresh'] as const;
export const BUSINESS_PERMISSION_CATALOG = [
  { id: 'knowledge', label: '运维知识库', page: '/operations-kb', scoped: false, actions: editing },
  { id: 'meetings', label: '议事航迹', page: '/meeting-management', scoped: false, actions: [...editing,'notify'] },
  { id: 'system_reports', label: '体系月报', page: '/system-monthly-report', scoped: false, actions: [...editing, 'approve'] },
  { id: 'monthly_reports', label: '月度报告', page: '/ali-monthly-report', scoped: false, actions: [...editing,'notify'] },
  { id: 'risk', label: '风险排查', page: '/risk-inspection-dashboard', scoped: true, actions: ['read', 'update', 'export', 'refresh'] },
  { id: 'quality', label: '质量评估', page: '/quality-assessment', scoped: true, actions: ['read', 'update', 'export', 'refresh'] },
  { id: 'alarms', label: '月度告警', page: '/monthly-alarm-overview', scoped: true, actions: reading },
  { id: 'equipment_ledger', label: '设备台账', page: '/equipment-ledger-management', scoped: true, actions: reading },
  { id: 'equipment_lifecycle', label: '设备全生命周期', page: '/equipment-lifecycle-dashboard', scoped: true, actions: reading },
  { id: 'thresholds', label: '阈值管理', page: '/threshold-management', scoped: true, actions: ['read', 'create', 'update', 'export', 'refresh'] },
  { id: 'patrol', label: '巡检管理', page: '/equipment-patrol-dashboard', scoped: true, actions: reading },
  { id: 'exhaust_valves', label: '排气阀定位', page: '/exhaust-valve-map', scoped: true, actions: reading },
  { id: 'purchase', label: '采购管理', page: '/purchase-inventory-management', scoped: true, actions: [...editing, 'approve', 'order', 'receive','notify'] },
  { id: 'inventory', label: '库存与出入库', page: '/inventory-management', scoped: true, actions: [...editing, 'confirm','notify'] },
  { id: 'stocktake', label: '库存盘点', page: '/inventory-management', scoped: true, actions: [...editing, 'confirm'] },
  { id: 'tools', label: '运维工具', page: '/operations-tools-management', scoped: true, actions: reading },
  { id: 'contracts', label: '合同管理', page: '/contract-management', scoped: true, actions: [...editing, 'confirm','notify'] },
  { id: 'base_portal', label: '基地门户', page: '/nantong-base', scoped: false, actions: ['read'] },
  { id: 'architecture', label: '业务架构', page: '/operations-architecture', scoped: false, actions: ['read'] },
  { id: 'today_focus', label: '重点事项与日历', page: '/today-focus-checklist', scoped: false, actions: editing },
  { id: 'today_operations', label: '今日航图', page: '/today-operations-panorama', scoped: false, actions: ['read', 'refresh','update'] },
  { id: 'alarm_review', label: '告警人工核对', page: '/today-operations-panorama', scoped: false, actions: ['read', 'update', 'confirm'] },
  { id: 'monthly_operations', label: '智舱月览', page: '/monthly-operations', scoped: false, actions: ['read', 'refresh','export'] },
  { id: 'campus_operations', label: '主变运行', page: '/campus-operations-dashboard', scoped: false, actions: ['read', 'refresh'] },
  { id: 'monthly_schedule', label: '排班总览', page: '/monthly-schedule', scoped: false, actions: ['read', 'refresh','notify'] },
  { id: 'schedule_assignments', label: '排班与人员调整', page: '/monthly-schedule', scoped: false, actions: ['read', 'create', 'update', 'delete','refresh'] },
  { id: 'personnel_schedule', label: '人员排班明细', page: '/monthly-schedule', scoped: false, actions: ['read','refresh'] },
  { id: 'non_duty_schedule', label: '非值班人员排班', page: '/monthly-schedule', scoped: false, actions: ['read','refresh'] },
  { id: 'schedule_diagnostics', label: '排班核查与修复', page: '/monthly-schedule', scoped: false, actions: ['read','update','refresh'] },
  { id: 'leave_requests', label: '请休假申请', page: '/monthly-schedule', scoped: false, actions: ['read', 'create'] },
  { id: 'overtime_requests', label: '加班申请', page: '/monthly-schedule', scoped: false, actions: ['read', 'create'] },
  { id: 'attendance', label: '考勤与工时', page: '/monthly-schedule', scoped: false, actions: ['read', 'export', 'refresh'] },
  { id: 'personnel_time_insights', label: '人员工时与休假分析', page: '/monthly-schedule', scoped: false, actions: ['read'] },
  { id: 'change_management', label: '变更与演练记录', page: '/monthly-schedule', scoped: false, actions: editing },
  { id: 'change_requests', label: '变更申请', page: '/monthly-schedule', scoped: false, actions: ['create'] },
  { id: 'change_documents', label: '变更记录附件', page: '/monthly-schedule', scoped: false, actions: ['read','export'] },
  { id: 'exception_followup', label: '异常事项跟进', page: '/monthly-schedule', scoped: false, actions: editing },
  { id: 'organization', label: '组织与人员资料', page: '/organization', scoped: false, actions: ['read', 'refresh'] },
  { id: 'organization_profile', label: '组织人员详细档案', page: '/organization', scoped: false, actions: ['read'] },
  { id: 'personnel_profile', label: '排班人员详细资料', page: '/monthly-schedule', scoped: false, actions: ['read','refresh'] },
  { id: 'training', label: '培训管理', page: '/training-certification-management', scoped: false, actions: ['read', 'refresh'] },
  { id: 'certification', label: '持证管理', page: '/training-certification-management', scoped: false, actions: ['read', 'refresh','notify'] },
  { id: 'construction', label: '施工项目与跟进', page: '/construction-management', scoped: false, actions: [...editing, 'confirm'] },
  { id: 'personality', label: '性格测评', page: '/mbti-assessment', scoped: false, actions: ['read','create'] },
  { id: 'external_twin', label: '孪生图谱入口', page: 'https://www.sm.sjhl.online:8787/', scoped: false, actions: ['read'] },
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
type PolicyPrincipal = Pick<AccessPrincipal, 'role' | 'specialties'> & Partial<Pick<AccessPrincipal, 'purchaseBuilding' | 'buildings' | 'personalRules' | 'permissionContext' | 'effectiveAuthorization'>>;
export interface BusinessPermissionTarget extends BusinessPermissionContext { building?: unknown; specialty?: unknown; }
export interface BusinessPermissionDecision { allowed: boolean; source: 'deny' | 'allow' | 'role' | 'none'; }

export function businessModuleDefinition(module: BusinessModule) {
  return BUSINESS_PERMISSION_CATALOG.find(item => item.id === module)!;
}
const configuredActions = new Map<BusinessModule, readonly BusinessAction[]>();
export function configurableBusinessActions(module:BusinessModule): readonly BusinessAction[] {
  const cached=configuredActions.get(module);
  if(cached)return cached;
  const definition=businessModuleDefinition(module);
  const actions=new Set<BusinessAction>();
  for(const route of PERMISSION_ROUTE_CLASSIFICATIONS){
    if(route.permission?.module===module){
      actions.add(route.permission.action);
      for(const action of route.recordDependent?.candidateActions || []) actions.add(action);
      if(route.refreshQueries?.length) actions.add('refresh');
    }
    if(route.refreshPermission?.module===module) actions.add(route.refreshPermission.action);
    for(const dependency of route.dependencies || []) if(dependency.module===module) actions.add(dependency.action);
    for(const permission of route.selectorPermissions || []) if(permission.module===module) actions.add(permission.action);
  }
  if(['base_portal','architecture','external_twin','exhaust_valves'].includes(module)) actions.add('read');
  const result=Object.freeze(definition.actions.filter(action=>actions.has(action)));
  configuredActions.set(module,result);
  return result;
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
export function isProfessionalBusinessPrincipal<T extends Pick<AccessPrincipal, 'role' | 'personalRules' | 'permissionContext'> & Partial<Pick<AccessPrincipal, 'effectiveAuthorization'>>>(principal: T | undefined): principal is T & ({ role: 'professional_admin' | 'professional_engineer' } | { personalRules: readonly PersonalPermissionRule[] } | { effectiveAuthorization: NonNullable<AccessPrincipal['effectiveAuthorization']> }) {
  if (!principal) return false;
  const profile = principal.effectiveAuthorization;
  return principal.role === 'professional_admin' || principal.role === 'professional_engineer' ||
    !!principal.personalRules?.some(rule => !principal.permissionContext || rule.module === principal.permissionContext.module) ||
    !!profile && (profile.baseline.nativeRole === null || !!profile.baseline.grantSnapshots?.length || [...profile.baseline.rules, ...profile.overrides.rules].some(rule => !principal.permissionContext || rule.module === principal.permissionContext.module));
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
function denyCouldMatch(rule:PersonalPermissionRule,target:BusinessPermissionTarget):boolean {
  if(rule.effect!=='deny'||rule.module!==target.module||!rule.actions.includes(target.action))return false;
  const buildings=normalizedBusinessBuildings(target.building),specialties=validTargetSpecialties(target.specialty);
  return (rule.buildings===null || !buildings.length || buildings.some(value=>rule.buildings!.includes(value))) &&
    (rule.specialties===null || !specialties.length || specialties.some(value=>rule.specialties!.includes(value)));
}
function roleDefault(principal: PolicyPrincipal, target: BusinessPermissionTarget): boolean {
  if (principal.role === 'admin') return true;
  if (target.module === 'organization_profile') return principal.role === 'editor';
  if (target.module === 'personnel_time_insights') return false;
  if (target.module === 'personnel_profile') return ['editor','duty_editor'].includes(principal.role);
  if (target.module === 'change_requests') return target.action === 'create' && principal.role !== 'site_member';
  if (target.module === 'personality' && target.action === 'create') return principal.role !== 'site_member';
  if (target.module === 'change_documents') return ['editor','duty_editor'].includes(principal.role);
  if (target.module === 'change_management' && target.action === 'delete') return ['editor','duty_editor'].includes(principal.role);
  if (target.module === 'personnel_schedule') return target.action === 'read' ? principal.role !== 'guest' : !['guest','site_member','professional_admin','professional_engineer'].includes(principal.role);
  if (target.module === 'non_duty_schedule') return principal.role === 'editor' || target.action === 'read' && principal.role === 'site_member';
  if (target.module === 'schedule_diagnostics') return principal.role === 'editor';
  if (target.module === 'attendance') return target.action === 'read' ? principal.role !== 'guest' : !['guest','site_member','professional_admin','professional_engineer'].includes(principal.role);
  if (target.module === 'schedule_assignments' && target.action === 'read') return ['editor','duty_editor','site_member'].includes(principal.role);
  const definition = businessModuleDefinition(target.module);
  if (!definition) return false;
  if (['base_portal', 'architecture', 'today_focus', 'today_operations', 'alarm_review', 'monthly_operations', 'campus_operations', 'monthly_schedule', 'schedule_assignments', 'leave_requests', 'overtime_requests', 'attendance', 'change_management', 'exception_followup', 'organization', 'training', 'certification', 'construction', 'personality', 'external_twin'].includes(target.module)) {
    if (target.action === 'read') return effectivePagePaths(principal.role).includes(definition.page);
    if (target.action === 'create' && ['leave_requests', 'overtime_requests'].includes(target.module)) return true;
    if (target.module === 'construction') return principal.role === 'construction_admin' ||
      principal.role === 'editor' && target.action !== 'delete';
    return ['editor','duty_editor'].includes(principal.role) && !['delete','approve'].includes(target.action);
  }
  if (principal.role === 'professional_admin' || principal.role === 'professional_engineer') {
    if (!definition.scoped) return true;
    const specialties = validTargetSpecialties(target.specialty);
    if (!specialties.length || !specialties.every(value => principal.specialties?.includes(value))) return false;
    if (principal.role === 'professional_admin') return true;
    const buildings = normalizedBusinessBuildings(target.building);
    return !!buildings.length && buildings.every(value => (principal.buildings || [principal.purchaseBuilding]).includes(value));
  }
  const supply = ['purchase', 'inventory', 'stocktake', 'contracts', 'tools'].includes(target.module);
  if (principal.role === 'editor') return target.module !== 'contracts' &&
    (target.module === 'purchase' && target.action === 'delete' || !['delete', 'approve', 'order'].includes(target.action));
  if (['purchase_admin', 'supply_chain_admin'].includes(principal.role)) return supply;
  if (['building_admin', 'inventory_admin', 'purchase_applicant'].includes(principal.role)) {
    if(principal.role==='purchase_applicant' && ['approve','notify','refresh'].includes(target.action)) return false;
    const modules = principal.role === 'building_admin' ? ['purchase', 'inventory', 'stocktake', 'tools', 'equipment_ledger', 'risk', 'quality', 'alarms'] : principal.role === 'inventory_admin' ? ['inventory', 'stocktake', 'tools'] : ['purchase'];
    const buildings = normalizedBusinessBuildings(target.building);
    return modules.includes(target.module) && !!buildings.length && buildings.every(value => (principal.buildings || [principal.purchaseBuilding]).includes(value));
  }
  return false;
}
export function decideBusinessPermission(principal: PolicyPrincipal, target: BusinessPermissionTarget): BusinessPermissionDecision {
  return evaluateBusinessPermission(principal,target,false);
}
/** One immutable policy snapshot per matrix/preview avoids validating every record point again. */
export function createBusinessPermissionEvaluator(principal:PolicyPrincipal):(target:BusinessPermissionTarget)=>BusinessPermissionDecision {
  const snapshot:PolicyPrincipal=structuredClone({role:principal.role,purchaseBuilding:principal.purchaseBuilding,
    buildings:principal.buildings,specialties:principal.specialties,personalRules:principal.personalRules,
    effectiveAuthorization:principal.effectiveAuthorization,permissionContext:principal.permissionContext});
  const valid=(snapshot.personalRules===undefined || validPersonalRules(snapshot.personalRules)) &&
    (!snapshot.effectiveAuthorization || validEffectiveAuthorization(snapshot.effectiveAuthorization,snapshot.role==='admin'));
  return target=>valid?evaluateBusinessPermission(snapshot,target,true):{allowed:false,source:'none'};
}
function evaluateBusinessPermission(principal:PolicyPrincipal, target:BusinessPermissionTarget, validated:boolean):BusinessPermissionDecision {
  const definition = BUSINESS_PERMISSION_CATALOG.find(item => item.id === target.module);
  if (!definition || !(definition.actions as readonly string[]).includes(target.action) ||
    (!validated && principal.personalRules !== undefined && !validPersonalRules(principal.personalRules))) return { allowed: false, source: 'none' };
  if (principal.effectiveAuthorization) return decideAuthorizationProfile(principal, target,validated);
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
function decideAuthorizationProfile(principal: PolicyPrincipal, target: BusinessPermissionTarget, validated=false): BusinessPermissionDecision {
  const profile = principal.effectiveAuthorization!;
  const definition = businessModuleDefinition(target.module);
  if (!validated && !validEffectiveAuthorization(profile, principal.role === 'admin')) return { allowed:false, source:'none' };
  if (principal.role === 'admin') return { allowed:true, source:'role' };
  const buildings = normalizedBusinessBuildings(target.building), specialties = validTargetSpecialties(target.specialty);
  const grants = profile.baseline.grantSnapshots || [];
  const points = definition.scoped && buildings.length && specialties.length ? buildings.flatMap(building => specialties.map(specialty => ({...target,building,specialty}))) : [target];
  const decisions = points.map((point: BusinessPermissionTarget) => {
    const own = overrideDecision(profile.overrides, point, principal, profile.baseline);
    if (own) return own;
    const inherited = [baseDecision(profile.baseline, principal, point), ...grants.map(grant => {
      const origin = {...principal, purchaseBuilding:grant.scope.building, buildings:grant.scope.buildings, specialties:grant.scope.specialties};
      for (const layer of [...(grant.overrideLayers || [])].reverse().concat([grant.overrides])) {
        const decision = overrideDecision(layer, point, origin, grant.baseline);
        if (decision) return decision;
      }
      return baseDecision(grant.baseline, origin, point);
    })];
    // Separate handover sources are grants; only the recipient's outer deny revokes their union.
    return inherited.find(decision => decision.allowed) || inherited.find(decision => decision.source === 'deny') || {allowed:false,source:'none'} as BusinessPermissionDecision;
  });
  if (decisions.some(value=>!value.allowed)) return {allowed:false,source:decisions.some(value=>value.source==='deny')?'deny':'none'};
  return {allowed:true,source:decisions.some(value=>value.source==='allow')?'allow':'role'};
}
function validBasePolicy(value: AuthorizationBasePolicy, administrator: boolean): boolean {
  return !!value && validPersonalRules(value.rules) && validPagePaths(value.pages) &&
    (value.nativeRole === null || PAGE_ACCESS_ROLES.includes(value.nativeRole)) &&
    (administrator || value.nativeRole !== 'admin');
}
function validOverrides(value: AuthorizationOverrides): boolean {
  return !!value && validPersonalRules(value.rules) && validPagePaths(value.allowPages) && validPagePaths(value.denyPages);
}
export function validEffectiveAuthorization(value: EffectiveAuthorization, administrator = false): boolean {
  if (!value || !['follow','independent'].includes(value.mode) || !validBasePolicy(value.baseline,administrator) || !validOverrides(value.overrides)) return false;
  const grants = value.baseline.grantSnapshots;
  return grants === undefined || Array.isArray(grants) && grants.length <= 8 && grants.every(grant =>
    !!grant && validBasePolicy(grant.baseline,administrator) && !('grantSnapshots' in grant.baseline) &&
    validOverrides(grant.overrides) && (grant.overrideLayers === undefined || Array.isArray(grant.overrideLayers) && grant.overrideLayers.length <= 8 && grant.overrideLayers.every(validOverrides)) &&
    !!grant.scope && validBuildingScope(grant.baseline.nativeRole || 'guest',grant.scope.building,grant.scope.buildings) &&
    (grant.scope.specialties === undefined || validSelection(grant.scope.specialties,PROFESSIONAL_SPECIALTIES)) &&
    (!['professional_admin','professional_engineer'].includes(grant.baseline.nativeRole || '') || !!grant.scope.specialties?.length));
}
function pageReadInScope(base: AuthorizationBasePolicy, principal: PolicyPrincipal, point: BusinessPermissionTarget): boolean {
  const definition = businessModuleDefinition(point.module);
  if (['organization_profile','personnel_profile','personnel_time_insights','attendance','schedule_assignments','personnel_schedule','non_duty_schedule','schedule_diagnostics','change_documents'].includes(point.module)) return base.nativeRole!==null && roleDefault({...principal,role:base.nativeRole},point);
  if (!definition.scoped || point.module === 'exhaust_valves') return true;
  if (base.nativeRole === null) return false;
  return nativeRecordScopeAllows(base,principal,point);
}
function nativeRecordScopeAllows(base: AuthorizationBasePolicy, principal: PolicyPrincipal, point: BusinessPermissionTarget): boolean {
  if (base.nativeRole === null || !businessModuleDefinition(point.module).scoped) return true;
  const selected = principal.buildings || (principal.purchaseBuilding ? [principal.purchaseBuilding] : []);
  const buildings = normalizedBusinessBuildings(point.building), specialties = validTargetSpecialties(point.specialty);
  return (!roleBuildingOptions(base.nativeRole) || buildings.length > 0 && buildings.every(value => selected.includes(value))) &&
    (!['professional_admin','professional_engineer'].includes(base.nativeRole) || specialties.length > 0 && specialties.every(value => principal.specialties?.includes(value)));
}
function overrideDecision(layer: AuthorizationOverrides, point: BusinessPermissionTarget, principal: PolicyPrincipal, base: AuthorizationBasePolicy): BusinessPermissionDecision | undefined {
  const page = businessModuleDefinition(point.module).page;
  const matches = layer.rules.filter(rule => ruleMatches(rule,point));
  if (layer.denyPages.includes(page) || layer.rules.some(rule=>denyCouldMatch(rule,point))) return {allowed:false,source:'deny'};
  if (matches.some(rule => rule.effect === 'allow')) return {allowed:true,source:'allow'};
  if (point.action === 'read' && layer.allowPages.includes(page) && pageReadInScope(base,principal,point)) return {allowed:true,source:'allow'};
  return undefined;
}
function baseDecision(base: AuthorizationBasePolicy, principal: PolicyPrincipal, point: BusinessPermissionTarget): BusinessPermissionDecision {
  const matches = base.rules.filter(rule => ruleMatches(rule,point));
  if (base.rules.some(rule=>denyCouldMatch(rule,point))) return {allowed:false,source:'deny'};
  if (matches.some(rule => rule.effect === 'allow') && nativeRecordScopeAllows(base,principal,point)) return {allowed:true,source:'role'};
  if (['organization_profile','personnel_profile','personnel_time_insights'].includes(point.module)) {
    const allowed=base.nativeRole!==null && roleDefault({...principal,role:base.nativeRole},point);
    return {allowed,source:allowed?'role':'none'};
  }
  const allowed = point.action === 'read'
    ? base.pages.includes(businessModuleDefinition(point.module).page) && pageReadInScope(base,principal,point)
    : base.nativeRole !== null && roleDefault({...principal,role:base.nativeRole,personalRules:[],effectiveAuthorization:undefined},point);
  return {allowed,source:allowed?'role':'none'};
}
export function canPerformBusinessAction(principal: PolicyPrincipal, target: BusinessPermissionTarget): boolean {
  return decideBusinessPermission(principal, target).allowed;
}
export function hasBusinessPermissionSomewhere(principal: PolicyPrincipal, context: BusinessPermissionContext): boolean {
  return hasPermissionSomewhere(createBusinessPermissionEvaluator(principal),context);
}
function hasPermissionSomewhere(decide:(target:BusinessPermissionTarget)=>BusinessPermissionDecision, context:BusinessPermissionContext):boolean {
  if (!businessModuleDefinition(context.module)) return false;
  if (!businessModuleDefinition(context.module).scoped) return decide(context).allowed;
  return BUILDING_ADMIN_BUILDINGS.some(building => PROFESSIONAL_SPECIALTIES.some(specialty => decide({ ...context, building, specialty }).allowed));
}
export function businessModuleForPage(path: string): BusinessModule | undefined {
  const clean=path.split(/[?#]/u)[0];
  return [...BUSINESS_PERMISSION_CATALOG].sort((a,b)=>b.page.length-a.page.length).find(item => clean === item.page || clean.startsWith(`${item.page}/`))?.id;
}
export function businessModulesForPage(path: string): BusinessModule[] {
  const first = businessModuleForPage(path);
  return first ? BUSINESS_PERMISSION_CATALOG.filter(item => item.page === businessModuleDefinition(first).page).map(item => item.id) : [];
}
export function personalPermissionPagePaths(principal: AccessPrincipal, inherited: readonly string[]): string[] {
  const profile=principal.effectiveAuthorization;
  const decide=createBusinessPermissionEvaluator(principal);
  if (profile) {
    if (!validEffectiveAuthorization(profile,principal.role==='admin')) return [];
    if(principal.role==='admin')return effectivePagePaths('admin');
    const result=new Set([...profile.baseline.pages,...profile.overrides.allowPages]);
    for(const page of new Set(BUSINESS_PERMISSION_CATALOG.map(item=>item.page))){
      const modules=BUSINESS_PERMISSION_CATALOG.filter(item=>item.page===page);
      if(modules.some(item=>hasPermissionSomewhere(decide,{module:item.id,action:'read'})))result.add(page);else result.delete(page);
    }
    for(const page of profile.overrides.denyPages)result.delete(page);
    result.delete('/system-configuration');
    return [...result];
  }
  if (!principal.personalRules?.length) return [...inherited];
  const result = new Set(inherited);
  for (const page of new Set(BUSINESS_PERMISSION_CATALOG.map(item => item.page))) {
    const definitions = BUSINESS_PERMISSION_CATALOG.filter(item => item.page === page);
    if (!definitions.some(item => principal.personalRules!.some(rule => rule.module === item.id && rule.actions.includes('read')))) continue;
    if (definitions.some(item => hasPermissionSomewhere(decide, { module: item.id, action: 'read' }))) result.add(page);
    else result.delete(page);
  }
  return [...result];
}
function businessAuthorizationIdentityParts(principal: AccessPrincipal): unknown[] {
  return [principal.accountId, principal.authorizationVersion, principal.role, principal.purchaseBuilding, principal.buildings, principal.specialties, principal.personalRules, principal.effectiveAuthorization];
}
/** Durable task ownership is independent of the route used to observe that task. */
export function businessAuthorizationIdentityKey(principal: AccessPrincipal): string {
  return JSON.stringify(businessAuthorizationIdentityParts(principal));
}
export function businessPermissionScopeKey(principal: AccessPrincipal): string {
  // Preserve the existing serialized layout used by action caches and fingerprints.
  return JSON.stringify([...businessAuthorizationIdentityParts(principal), principal.permissionContext, principal.permissionRequirements]);
}
export function businessAuthorizationSnapshot(principal: AccessPrincipal): AccessPrincipal {
  return structuredClone({ role: principal.role, purchaseBuilding: principal.purchaseBuilding,
    ...(principal.buildings ? { buildings: principal.buildings } : {}), ...(principal.specialties ? { specialties: principal.specialties } : {}),
    ...(principal.personalRules ? { personalRules: principal.personalRules } : {}), ...(principal.permissionContext ? { permissionContext: principal.permissionContext } : {}),
    ...(principal.permissionRequirements ? { permissionRequirements:principal.permissionRequirements } : {}),
    ...(principal.effectiveAuthorization ? { effectiveAuthorization: principal.effectiveAuthorization } : {}),
    ...(principal.accountId ? { accountId: principal.accountId } : {}), ...(principal.authorizationVersion !== undefined ? { authorizationVersion: principal.authorizationVersion } : {}),
    ...(principal.displayName ? { displayName: principal.displayName } : {}) });
}
export function validScopedBusinessPrincipal(value: unknown): value is AccessPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as AccessPrincipal;
  if ((principal.authorizationVersion !== undefined && (!Number.isSafeInteger(principal.authorizationVersion) || principal.authorizationVersion < 1)) || (principal.permissionContext !== undefined && !BUSINESS_PERMISSION_CATALOG.some(item => item.id === principal.permissionContext!.module && (item.actions as readonly string[]).includes(principal.permissionContext!.action))) || !isProfessionalBusinessPrincipal(principal) || !validBuildingScope(principal.role, principal.purchaseBuilding, principal.buildings) || !principal.accountId ||
    (principal.personalRules !== undefined && !validPersonalRules(principal.personalRules)) ||
    (principal.effectiveAuthorization !== undefined && !validEffectiveAuthorization(principal.effectiveAuthorization,principal.role==='admin')) ||
    (principal.permissionRequirements!==undefined && (!Array.isArray(principal.permissionRequirements) || principal.permissionRequirements.length>5 || principal.permissionRequirements.some(required=>!BUSINESS_PERMISSION_CATALOG.some(item=>item.id===required?.module && (item.actions as readonly string[]).includes(required?.action)))))) return false;
  if (principal.role === 'professional_admin' || principal.role === 'professional_engineer') return Array.isArray(principal.specialties) && principal.specialties.length > 0 &&
    principal.specialties.every(value => PROFESSIONAL_SPECIALTIES.includes(value)) && new Set(principal.specialties).size === principal.specialties.length;
  return !!principal.personalRules?.length || !!principal.effectiveAuthorization;
}
export function businessBuildingsForAction(principal: PolicyPrincipal, context: BusinessPermissionContext): BuildingAdminBuilding[] {
  return BUILDING_ADMIN_BUILDINGS.filter(building => PROFESSIONAL_SPECIALTIES.some(specialty => canPerformBusinessAction(principal, { ...context, building, specialty })));
}
