import type { EffectiveAuthorization } from '@shared/authorization-profile';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { businessModuleDefinition, configurableBusinessActions, createBusinessPermissionEvaluator, decideBusinessPermission, validPersonalRules, type BusinessAction, type BusinessModule, type BusinessPermissionDecision, type PersonalPermissionRule } from '@shared/business-permissions';
import { editPersonalPermission, type PersonalPermissionMode, type PersonalPermissionScope } from './personal-permission-editing';

type ScopeDimension = 'buildings' | 'specialties';
const scopeRuleId = (module: BusinessModule, dimension: ScopeDimension) => `editor-scope-${module}-${dimension}`;
function scopeRule(rule: PersonalPermissionRule, module: BusinessModule, dimension: ScopeDimension): boolean {
  const actions = businessModuleDefinition(module).actions;
  return rule.id === scopeRuleId(module, dimension) && rule.module === module && rule.effect === 'deny' &&
    rule[dimension] !== null && rule[dimension === 'buildings' ? 'specialties' : 'buildings'] === null &&
    rule.actions.length === actions.length && actions.every(action => rule.actions.includes(action));
}

export function editAuthorizationScope(value: EffectiveAuthorization, template: boolean, scope: PersonalPermissionScope): EffectiveAuthorization {
  const definition = businessModuleDefinition(scope.module);
  if (!definition.scoped) throw new Error('此功能不支持楼栋或专业范围');
  const current = template ? value.baseline.rules : value.overrides.rules;
  const ids = (['buildings', 'specialties'] as const).map(dimension => scopeRuleId(scope.module, dimension));
  if (current.some(rule => ids.includes(rule.id) && !(['buildings', 'specialties'] as const).some(dimension => scopeRule(rule, scope.module, dimension)))) throw new Error('范围规则冲突，请刷新配置后重试');
  const rules = current.filter(rule => !ids.includes(rule.id));
  for (const dimension of ['buildings', 'specialties'] as const) {
    const options = dimension === 'buildings' ? BUILDING_ADMIN_BUILDINGS : PROFESSIONAL_SPECIALTIES;
    const selected = scope[dimension];
    if (selected !== null && (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(item => !(options as readonly string[]).includes(item)))) throw new Error('请选择有效的楼栋和专业');
    const outside = selected === null ? [] : options.filter(item => !(selected as readonly string[]).includes(item));
    if (outside.length) rules.push({ id: scopeRuleId(scope.module, dimension), module: scope.module, effect: 'deny', actions: [...definition.actions], buildings: null, specialties: null, [dimension]: [...outside] } as PersonalPermissionRule);
  }
  if (!validPersonalRules(rules)) throw new Error('最多100条权限规则，请先合并后重试');
  return template ? { ...value, baseline: { ...value.baseline, rules } } : { ...value, overrides: { ...value.overrides, rules } };
}

type ModulePoint = { building?: typeof BUILDING_ADMIN_BUILDINGS[number]; specialty?: typeof PROFESSIONAL_SPECIALTIES[number] } & BusinessPermissionDecision;
export function authorizationModuleState(value: EffectiveAuthorization, principal: AccessPrincipal, module: BusinessModule, template = false) {
  const definition = businessModuleDefinition(module), actor = { ...principal, effectiveAuthorization: value };
  const decide = createBusinessPermissionEvaluator(actor);
  const points: Pick<ModulePoint, 'building' | 'specialty'>[] = definition.scoped ? BUILDING_ADMIN_BUILDINGS.flatMap(building => PROFESSIONAL_SPECIALTIES.map(specialty => ({ building, specialty }))) : [{}];
  const actions = configurableBusinessActions(module).map(action => ({ action, points: points.map(point => ({ ...point,
    ...(template && point.building && point.specialty ? decideBusinessPermission({ ...actor, purchaseBuilding: point.building, buildings: [point.building], specialties: [point.specialty] }, { module, action, ...point }) : decide({ module, action, ...point })),
  })) as ModulePoint[] }));
  const rules = template ? value.baseline.rules : value.overrides.rules;
  const buildingRule = rules.find(rule => scopeRule(rule, module, 'buildings'));
  const specialtyRule = rules.find(rule => scopeRule(rule, module, 'specialties'));
  const buildings = buildingRule ? BUILDING_ADMIN_BUILDINGS.filter(item => !buildingRule.buildings!.includes(item)) : null;
  const specialties = specialtyRule ? PROFESSIONAL_SPECIALTIES.filter(item => !specialtyRule.specialties!.includes(item)) : null;
  return { scope: { module, buildings: buildings?.length === BUILDING_ADMIN_BUILDINGS.length ? null : buildings, specialties: specialties?.length === PROFESSIONAL_SPECIALTIES.length ? null : specialties } satisfies PersonalPermissionScope, actions };
}

export function editAuthorizationAction(value: EffectiveAuthorization, template: boolean, scope: PersonalPermissionScope, action: BusinessAction, mode: PersonalPermissionMode, newId: () => string): EffectiveAuthorization {
  const current = template ? value.baseline.rules : value.overrides.rules;
  // Action edits must not remove the module-wide range chosen above them.
  const caps = current.filter(rule => (['buildings', 'specialties'] as const).some(dimension => scopeRule(rule, scope.module, dimension)));
  const rules = [...editPersonalPermission(current.filter(rule => !caps.includes(rule)), scope, action, mode, newId), ...caps];
  if (!validPersonalRules(rules)) throw new Error('最多100条权限规则，请先合并后重试');
  return template ? { ...value, baseline: { ...value.baseline, rules } } : { ...value, overrides: { ...value.overrides, rules } };
}

export function editAuthorizationPage(value: EffectiveAuthorization, template: boolean, page: string, mode: PersonalPermissionMode): EffectiveAuthorization {
  if (template) return { ...value, baseline: { ...value.baseline, pages: mode === 'allow' ? [...new Set([...value.baseline.pages, page])] : value.baseline.pages.filter(item => item !== page) } };
  return { ...value, overrides: { ...value.overrides,
    allowPages: [...value.overrides.allowPages.filter(item => item !== page), ...(mode === 'allow' ? [page] : [])],
    denyPages: [...value.overrides.denyPages.filter(item => item !== page), ...(mode === 'deny' ? [page] : [])],
  } };
}

export function authorizationPageMode(value: EffectiveAuthorization, page: string): PersonalPermissionMode {
  return value.overrides.denyPages.includes(page) ? 'deny' : value.overrides.allowPages.includes(page) ? 'allow' : 'inherit';
}

export const emptyAuthorizationOverrides = () => ({ rules: [], allowPages: [], denyPages: [] });
