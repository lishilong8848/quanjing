import { BUILDING_ADMIN_BUILDINGS } from '@shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '@shared/professional-access';
import { businessModuleDefinition, validPersonalRules, type BusinessAction, type BusinessModule, type PersonalPermissionRule } from '@shared/business-permissions';

export type PersonalPermissionMode = 'inherit' | 'allow' | 'deny';
export interface PersonalPermissionScope {
  module: BusinessModule;
  buildings: PersonalPermissionRule['buildings'];
  specialties: PersonalPermissionRule['specialties'];
}
function scopePoints(scope: PersonalPermissionScope) {
  if (!businessModuleDefinition(scope.module).scoped) return [{ building: null, specialty: null }];
  return (scope.buildings || BUILDING_ADMIN_BUILDINGS).flatMap(building => (scope.specialties || PROFESSIONAL_SPECIALTIES).map(specialty => ({ building, specialty })));
}
export function personalPermissionMode(rules: PersonalPermissionRule[], scope: PersonalPermissionScope, action: BusinessAction): PersonalPermissionMode | 'mixed' {
  const modes = new Set(scopePoints(scope).map(point => {
    const matching = rules.filter(rule => rule.module === scope.module && rule.actions.includes(action) &&
      (rule.buildings === null || (point.building !== null && rule.buildings.includes(point.building))) &&
      (rule.specialties === null || (point.specialty !== null && rule.specialties.includes(point.specialty))));
    return matching.some(rule => rule.effect === 'deny') ? 'deny' : matching.some(rule => rule.effect === 'allow') ? 'allow' : 'inherit';
  }));
  return modes.size === 1 ? [...modes][0] : 'mixed';
}
export function editPersonalPermission(rules: PersonalPermissionRule[], scope: PersonalPermissionScope, action: BusinessAction, mode: PersonalPermissionMode, newId: () => string): PersonalPermissionRule[] {
  const definition = businessModuleDefinition(scope.module);
  const selection = { id: 'selection', module: scope.module, actions: [action], effect: 'allow' as const,
    buildings: definition.scoped ? scope.buildings : null, specialties: definition.scoped ? scope.specialties : null };
  if (!validPersonalRules(rules) || !validPersonalRules([selection]) || !['inherit', 'allow', 'deny'].includes(mode)) throw new Error('请检查操作、楼栋和专业选择');
  const selectedBuildings = selection.buildings || [...BUILDING_ADMIN_BUILDINGS];
  const selectedSpecialties = selection.specialties || [...PROFESSIONAL_SPECIALTIES];
  const result: PersonalPermissionRule[] = [];
  for (const rule of rules) {
    if (rule.module !== scope.module || !rule.actions.includes(action)) { result.push(rule); continue; }
    const buildings = rule.buildings || [...BUILDING_ADMIN_BUILDINGS], specialties = rule.specialties || [...PROFESSIONAL_SPECIALTIES];
    const overlapBuildings = buildings.filter(value => selectedBuildings.includes(value));
    const overlapSpecialties = specialties.filter(value => selectedSpecialties.includes(value));
    if (definition.scoped && (!overlapBuildings.length || !overlapSpecialties.length)) { result.push(rule); continue; }
    const remainingActions = rule.actions.filter(value => value !== action);
    if (remainingActions.length) result.push({ ...rule, actions: remainingActions });
    if (!definition.scoped) continue;
    // 从原矩形范围减去当前选择，保留范围外的原授权。
    const outsideBuildings = buildings.filter(value => !selectedBuildings.includes(value));
    const outsideSpecialties = specialties.filter(value => !selectedSpecialties.includes(value));
    if (outsideBuildings.length) result.push({ ...rule, id: newId(), actions: [action], buildings: outsideBuildings });
    if (outsideSpecialties.length) result.push({ ...rule, id: newId(), actions: [action], buildings: overlapBuildings, specialties: outsideSpecialties });
  }
  if (mode !== 'inherit') result.push({ ...selection, id: newId(), effect: mode });
  if (result.length > 100) throw new Error('最多100条个人规则，请先合并或删除规则');
  if (!validPersonalRules(result)) throw new Error('个人规则配置无效，请检查后重试');
  return result;
}
