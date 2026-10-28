import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '../../shared/professional-access';
import { businessModuleDefinition, canPerformBusinessAction, validPersonalRules, type PersonalPermissionRule } from '../../shared/business-permissions';
import type { EffectiveAuthorization } from '../../shared/authorization-profile';
import { authorizationModuleState, editAuthorizationAction, editAuthorizationScope } from '../../client/src/pages/SystemConfiguration/authorization-editing';

const actor: AccessPrincipal = { role: 'guest', purchaseBuilding: null };
const actions = [...businessModuleDefinition('inventory').actions];
const allow = (module: 'inventory' | 'purchase', id: string): PersonalPermissionRule => ({ id, module, effect: 'allow', actions: [...businessModuleDefinition(module).actions], buildings: null, specialties: null });
const profile = (mode: 'follow' | 'independent' = 'follow'): EffectiveAuthorization => ({ mode,
  ...(mode === 'follow' ? { templateId: 'synthetic-inventory', templateVersion: 1 } : {}),
  baseline: { nativeRole: null, pages: [], rules: [allow('inventory', 'inventory-base'), allow('purchase', 'purchase-base')] },
  overrides: { rules: [], allowPages: [], denyPages: [] },
});
const selected = { module: 'inventory' as const, buildings: ['B楼'] as PersonalPermissionRule['buildings'], specialties: ['电气'] as PersonalPermissionRule['specialties'] };
const permitted = (value: EffectiveAuthorization, building: string, specialty: string, action = actions[0]) => canPerformBusinessAction({ ...actor, effectiveAuthorization: value }, { module: 'inventory', action, building, specialty });
const caps = (value: EffectiveAuthorization, template = false) => (template ? value.baseline.rules : value.overrides.rules).filter(rule => rule.id.startsWith('editor-scope-inventory-'));

describe('saved module building and specialty scope', () => {
  it.each(['follow', 'independent'] as const)('scope-only %s changes survive serialization/reopen and restrict every action', mode => {
    const original = profile(mode), before = JSON.stringify(original);
    const changed = editAuthorizationScope(original, false, selected);
    const reopened = JSON.parse(JSON.stringify(changed)) as EffectiveAuthorization;
    expect(authorizationModuleState(reopened, actor, 'inventory').scope).toEqual(selected);
    expect(validPersonalRules(reopened.overrides.rules)).toBe(true);
    for (const action of actions) for (const building of BUILDING_ADMIN_BUILDINGS) for (const specialty of PROFESSIONAL_SPECIALTIES) {
      expect(permitted(reopened, building, specialty, action)).toBe(building === 'B楼' && specialty === '电气');
    }
    expect(canPerformBusinessAction({ ...actor, effectiveAuthorization: reopened }, { module: 'purchase', action: 'create', building: 'A楼', specialty: '暖通' })).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('clearing caps preserves manual denials and never adds an unavailable permission', () => {
    const manual: PersonalPermissionRule = { ...allow('inventory', 'manual-block'), effect: 'deny', actions: ['export'], buildings: ['B楼'], specialties: ['电气'] };
    const original = profile(); original.overrides.rules = [manual];
    const narrowed = editAuthorizationScope(original, false, selected);
    expect(narrowed.overrides.rules).toContainEqual(manual);
    const restored = editAuthorizationScope(narrowed, false, { ...selected, buildings: null, specialties: null });
    expect(restored.overrides.rules).toEqual([manual]);
    expect(permitted(restored, 'A楼', '暖通', 'create')).toBe(true);
    expect(permitted(restored, 'B楼', '电气', 'export')).toBe(false);
    const empty = profile('independent'); empty.baseline.rules = [];
    expect(permitted(editAuthorizationScope(empty, false, selected), 'B楼', '电气', 'create')).toBe(false);
  });

  it('action edits including broad inherit cannot split or delete the module caps', () => {
    const original = editAuthorizationScope(profile(), false, selected), retained = caps(original);
    let changed = original, counter = 0;
    for (const mode of ['allow', 'deny', 'inherit'] as const) {
      changed = editAuthorizationAction(changed, false, { ...selected, buildings: null, specialties: null }, 'read', mode, () => `edit-${++counter}`);
      expect(caps(changed)).toEqual(retained);
      expect(validPersonalRules(changed.overrides.rules)).toBe(true);
      expect(permitted(changed, 'A楼', '电气', 'read')).toBe(false);
    }
    expect(permitted(changed, 'B楼', '电气', 'read')).toBe(true);
  });

  it('uses baseline caps for a role template without changing its personal overrides', () => {
    const original = profile('independent');
    const changed = editAuthorizationScope(original, true, selected);
    expect(changed.overrides).toBe(original.overrides);
    expect(caps(changed, true)).toHaveLength(2);
    expect(authorizationModuleState(JSON.parse(JSON.stringify(changed)), actor, 'inventory', true).scope).toEqual(selected);
    expect(permitted(changed, 'B楼', '电气', 'create')).toBe(true);
    expect(permitted(changed, 'A楼', '电气', 'create')).toBe(false);
  });

  it('an empty selection persists an explicit deny-all, and selecting again restores only existing grants', () => {
    const disabled = editAuthorizationScope(profile(), false, { ...selected, buildings: [], specialties: null });
    expect(validPersonalRules(disabled.overrides.rules)).toBe(true);
    expect(authorizationModuleState(disabled, actor, 'inventory').scope.buildings).toEqual([]);
    for (const action of actions) for (const building of BUILDING_ADMIN_BUILDINGS) expect(permitted(disabled, building, '电气', action)).toBe(false);
    const restored = editAuthorizationScope(disabled, false, selected);
    expect(permitted(restored, 'B楼', '电气', 'create')).toBe(true);
    expect(permitted(restored, 'C楼', '电气', 'create')).toBe(false);
  });

  it('repeated range changes replace two rules without accumulation or touching another module', () => {
    let changed = profile();
    changed = editAuthorizationScope(changed, false, { module: 'purchase', buildings: ['A楼'], specialties: null });
    const purchaseRules = structuredClone(changed.overrides.rules);
    for (let index = 0; index < 100; index++) {
      changed = editAuthorizationScope(changed, false, { ...selected, buildings: index % 2 ? ['B楼'] : ['C楼'] });
      expect(caps(changed)).toHaveLength(2);
      expect(validPersonalRules(changed.overrides.rules)).toBe(true);
      expect(changed.overrides.rules.filter(rule => rule.module === 'purchase')).toEqual(purchaseRules);
    }
  });

  it('a later followed-role update keeps personal caps and manual exceptions', () => {
    const narrowed = editAuthorizationScope(profile(), false, selected);
    narrowed.baseline = { ...narrowed.baseline, rules: [allow('inventory', 'updated-role-grants')] };
    narrowed.templateVersion = 2;
    expect(authorizationModuleState(narrowed, actor, 'inventory').scope).toEqual(selected);
    expect(permitted(narrowed, 'A楼', '电气', 'confirm')).toBe(false);
    expect(permitted(narrowed, 'B楼', '电气', 'confirm')).toBe(true);
  });

  it('keeps an unrestricted module bound separate from older action-specific grants', () => {
    const value = profile('independent');
    value.baseline.rules = [{ ...allow('inventory', 'b-electric'), actions: ['create'], buildings: ['B楼'], specialties: ['电气'] },
      { ...allow('inventory', 'c-hvac'), actions: ['read'], buildings: ['C楼'], specialties: ['暖通'] }];
    const restored = authorizationModuleState(value, actor, 'inventory');
    expect(restored.scope).toEqual({ module: 'inventory', buildings: null, specialties: null });
    expect(restored.actions.find(item => item.action === 'create')!.points.filter(point => point.allowed)).toEqual([{ building: 'B楼', specialty: '电气', allowed: true, source: 'role' }]);
    expect(permitted(value, 'B楼', '暖通', 'create')).toBe(false);
  });

  it('all remains selectable after narrower caps on both a native H role and old B-only rules', () => {
    const native = profile(); native.baseline = { nativeRole: 'inventory_admin', pages: ['/inventory-management'], rules: [] };
    const older = profile('independent'); older.baseline.rules = [{ ...allow('inventory', 'b-only'), buildings: ['B楼'] }];
    const nativeActor: AccessPrincipal = { role: 'inventory_admin', purchaseBuilding: 'H楼', buildings: ['H楼'] };
    for (const [value, who, expectedBuilding] of [[native, nativeActor, 'H楼'], [older, actor, 'B楼']] as const) {
      const narrowed = editAuthorizationScope(value, false, selected);
      const unrestricted = editAuthorizationScope(narrowed, false, { ...selected, buildings: null, specialties: null });
      const reopened = authorizationModuleState(JSON.parse(JSON.stringify(unrestricted)), who, 'inventory');
      expect(reopened.scope).toEqual({ module: 'inventory', buildings: null, specialties: null });
      expect(reopened.actions.find(item => item.action === 'create')!.points.filter(point => point.allowed).map(point => point.building)).toEqual(PROFESSIONAL_SPECIALTIES.map(() => expectedBuilding));
      expect(caps(unrestricted)).toEqual([]);
    }
  });

  it('rejects malformed owned-ID collisions, invalid dimensions and overflow without changing input', () => {
    const value = profile(); value.overrides.rules = [{ ...allow('inventory', 'editor-scope-inventory-buildings'), actions: ['read'] }];
    const before = JSON.stringify(value);
    expect(() => editAuthorizationScope(value, false, selected)).toThrow('范围规则冲突');
    expect(JSON.stringify(value)).toBe(before);
    expect(() => editAuthorizationScope(profile(), false, { ...selected, buildings: ['未知楼'] as never })).toThrow('有效');
    const full = profile(); full.overrides.rules = Array.from({ length: 100 }, (_, index) => allow('purchase', `existing-${index}`));
    expect(() => editAuthorizationScope(full, false, selected)).toThrow('100');
    expect(full.overrides.rules).toHaveLength(100);
  });
});
