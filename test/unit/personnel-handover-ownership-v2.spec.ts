import type { AccountPermissionTemplate, HandoverGrantChoice } from '../../shared/personnel-handover.interface';
import type { AuthorizationGrantSnapshot, EffectiveAuthorization } from '../../shared/authorization-profile';
import type { PersonalPermissionRule } from '../../shared/business-permissions';
import { canPerformBusinessAction, personalPermissionPagePaths } from '../../shared/business-permissions';
import { authorizationPages } from '../../server/common/access/authorization-profile.policy';
import { handoverPermissionGrantKeys, handoverPermissionGrantMetadata, splitHandoverPermissionGrants } from '../../server/common/access/personnel-handover.ownership';

const emptyOverrides = () => ({ rules: [] as PersonalPermissionRule[], allowPages: [] as string[], denyPages: [] as string[] });
const rule = (id: string, module: PersonalPermissionRule['module'], effect: PersonalPermissionRule['effect'], actions: PersonalPermissionRule['actions'], building: 'A楼' | 'B楼' | 'H楼' = 'B楼'): PersonalPermissionRule => ({
  id, module, effect, actions, buildings: [building], specialties: ['电气'],
});
function actor(template: AccountPermissionTemplate) {
  return { role: template.role, purchaseBuilding: template.building, buildings: template.buildings, specialties: template.specialties,
    personalRules: template.personalRules, effectiveAuthorization: template.effectiveAuthorization };
}
function template(effective: EffectiveAuthorization, buildings: ('A楼' | 'B楼' | 'H楼')[] = ['A楼']): AccountPermissionTemplate {
  const role = effective.baseline.nativeRole || 'guest';
  const result: AccountPermissionTemplate = { role, building: role === 'professional_engineer' ? buildings[0] : null,
    ...(role === 'professional_engineer' ? { buildings: [...buildings], specialties: ['电气'] as ['电气'] } : {}),
    sourceVersion: 4, personalRules: structuredClone(effective.overrides.rules), effectiveAuthorization: effective, pagePaths: [] };
  result.pagePaths = personalPermissionPagePaths(actor(result), authorizationPages(effective));
  return result;
}
function source() {
  return template({ mode: 'follow', templateId: 'synthetic-role', templateVersion: 3,
    baseline: { nativeRole: 'professional_engineer', pages: [], rules: [
      rule('purchase-B', 'purchase', 'allow', ['read', 'update']),
      rule('purchase-B-limit', 'purchase', 'deny', ['update']),
      rule('inventory-H', 'inventory', 'allow', ['read'], 'H楼'),
    ] }, overrides: { rules: [rule('personal-B', 'purchase', 'allow', ['update']), rule('no-delete-B', 'purchase', 'deny', ['delete'])], allowPages: [], denyPages: ['/monthly-alarm-overview'] } }, ['A楼', 'B楼', 'H楼']);
}
function choices(value: AccountPermissionTemplate, selected: (key: string) => 'transfer' | 'retain' | 'shared' = () => 'retain'): HandoverGrantChoice[] {
  return handoverPermissionGrantKeys(value).map(key => {
    const disposition = selected(key);
    return { key, disposition, ...(disposition === 'retain' ? {} : { dutyRecordId: 'recDutyB' }) };
  });
}
const allowed = (value: AccountPermissionTemplate, module: 'purchase' | 'inventory', action: 'read' | 'update' | 'delete', building: 'A楼' | 'B楼' | 'H楼') =>
  canPerformBusinessAction(actor(value), { module, action, building, specialty: '电气' });

describe('layer-preserving V2 personnel permission ownership', () => {
  it('lists positive grants from each layer separately and never offers restrictions for removal', () => {
    const keys = handoverPermissionGrantKeys(source());
    expect(keys).toEqual(['v2:role', 'v2:base-rule:purchase-B', 'v2:base-rule:inventory-H', 'v2:personal-rule:personal-B']);
    expect(keys.some(key => key.includes('limit') || key.includes('no-delete'))).toBe(false);
  });
  it('transfers one module/range with its personal override while retaining unrelated grants and all restrictions', () => {
    const before = source(), bytes = JSON.stringify(before);
    expect(allowed(before, 'purchase', 'read', 'B楼')).toBe(true);
    expect(allowed(before, 'inventory', 'read', 'H楼')).toBe(true);
    const split = splitHandoverPermissionGrants(before, choices(before, key => ['v2:base-rule:purchase-B', 'v2:personal-rule:personal-B'].includes(key) ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.transfer.role).toBe('guest'); expect(split.transfer.effectiveAuthorization?.baseline.nativeRole).toBeNull();
    expect(split.transfer.effectiveAuthorization?.mode).toBe('independent');
    expect(split.transfer.effectiveAuthorization).not.toHaveProperty('templateId');
    expect(allowed(split.transfer, 'purchase', 'read', 'B楼')).toBe(true);
    expect(allowed(split.transfer, 'purchase', 'update', 'B楼')).toBe(true);
    expect(allowed(split.transfer, 'purchase', 'delete', 'B楼')).toBe(false);
    expect(allowed(split.transfer, 'inventory', 'read', 'H楼')).toBe(false);
    expect(allowed(split.retained, 'inventory', 'read', 'H楼')).toBe(true);
    expect(allowed(split.retained, 'purchase', 'read', 'B楼')).toBe(false);
    for (const side of [split.transfer, split.retained]) {
      expect(side.effectiveAuthorization?.baseline.rules).toContainEqual(before.effectiveAuthorization!.baseline.rules[1]);
      expect(side.effectiveAuthorization?.overrides.rules).toContainEqual(before.effectiveAuthorization!.overrides.rules[1]);
      expect(side.effectiveAuthorization?.overrides.denyPages).toEqual(['/monthly-alarm-overview']);
      expect(side.sourceVersion).toBe(4);
    }
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it('copies an atomic inherited grant with original scope and ordered override layers', () => {
    const snapshot: AuthorizationGrantSnapshot = {
      baseline: { nativeRole: 'professional_engineer', pages: [], rules: [rule('lower-deny', 'purchase', 'deny', ['update'])] },
      overrides: emptyOverrides(), overrideLayers: [{ ...emptyOverrides(), rules: [rule('later-allow', 'purchase', 'allow', ['update'])] }],
      scope: { building: 'B楼', buildings: ['B楼'], specialties: ['电气'] },
    };
    const before = template({ mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [], grantSnapshots: [snapshot] }, overrides: emptyOverrides() });
    const key = handoverPermissionGrantKeys(before).find(value => value.startsWith('v2:grant:'))!;
    expect(key).toMatch(/^v2:grant:[a-f0-9]{64}$/);
    expect(handoverPermissionGrantMetadata(before)[key]).toEqual({ title: '交接保留权限 #1（完整来源范围）', nativeRole: 'professional_engineer', scope: snapshot.scope });
    const split = splitHandoverPermissionGrants(before, choices(before, value => value === key ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.transfer.effectiveAuthorization?.baseline.grantSnapshots).toEqual([snapshot]);
    expect(allowed(split.transfer, 'purchase', 'update', 'B楼')).toBe(true);
    expect(allowed(split.transfer, 'purchase', 'update', 'A楼')).toBe(false);
    expect(split.retained.effectiveAuthorization?.baseline.grantSnapshots).toBeUndefined();
  });
  it('does not flatten an inherited grant under the outer personal deny', () => {
    const snapshot: AuthorizationGrantSnapshot = { baseline: { nativeRole: null, pages: [], rules: [rule('base-allow', 'purchase', 'allow', ['read', 'update'])] },
      overrides: emptyOverrides(), scope: { building: null } };
    const before = template({ mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [], grantSnapshots: [snapshot] },
      overrides: { ...emptyOverrides(), rules: [rule('outer-deny', 'purchase', 'deny', ['update'])] } });
    const split = splitHandoverPermissionGrants(before, choices(before, key => key.startsWith('v2:grant:') ? 'shared' : 'retain'), ['recDutyB']);
    for (const side of [split.transfer, split.retained]) {
      expect(allowed(side, 'purchase', 'read', 'B楼')).toBe(true);
      expect(allowed(side, 'purchase', 'update', 'B楼')).toBe(false);
      expect(side.effectiveAuthorization?.overrides.rules).toEqual(before.effectiveAuthorization?.overrides.rules);
    }
  });
  it('normalizes only empty/adjacent identical grant layers without changing the latest decision or source scope', () => {
    const denied = { ...emptyOverrides(), rules: [rule('limit', 'purchase', 'deny', ['update'])] };
    const lifted = { ...emptyOverrides(), rules: [rule('lift', 'purchase', 'allow', ['update'])] };
    const snapshot: AuthorizationGrantSnapshot = { baseline: { nativeRole: null, pages: [], rules: [rule('read-B', 'purchase', 'allow', ['read'])] },
      overrides: denied, overrideLayers: [structuredClone(denied), emptyOverrides(), lifted], scope: { building: null } };
    const before = template({ mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [], grantSnapshots: [snapshot] }, overrides: emptyOverrides() });
    const bytes = JSON.stringify(before);
    const split = splitHandoverPermissionGrants(before, choices(before, key => key.startsWith('v2:grant:') ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.transfer.effectiveAuthorization?.baseline.grantSnapshots?.[0]).toEqual({ ...snapshot, overrideLayers: [lifted] });
    expect(allowed(split.transfer, 'purchase', 'update', 'B楼')).toBe(allowed(before, 'purchase', 'update', 'B楼'));
    expect(allowed(split.transfer, 'purchase', 'update', 'A楼')).toBe(false);
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it('rejects moving the native role away from an explicitly retained page that depends on its record scope', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: ['/purchase-inventory-management'], rules: [] }, overrides: emptyOverrides() });
    const bytes = JSON.stringify(before);
    expect(() => splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:role' ? 'transfer' : 'retain'), ['recDutyB'])).toThrow('页面仍依赖');
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it('keeps a selected page when an independently retained read rule supports its exact scope', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: ['/purchase-inventory-management'], rules: [rule('retained-read', 'purchase', 'allow', ['read'], 'A楼')] }, overrides: emptyOverrides() });
    expect(allowed(before, 'purchase', 'read', 'A楼')).toBe(true);
    expect(allowed(before, 'purchase', 'read', 'B楼')).toBe(false);
    const split = splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:role' ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.retained.effectiveAuthorization?.baseline.nativeRole).toBeNull();
    expect(split.retained.pagePaths).toContain('/purchase-inventory-management');
    expect(allowed(split.retained, 'purchase', 'read', 'A楼')).toBe(true);
    expect(allowed(split.retained, 'purchase', 'read', 'B楼')).toBe(false);
  });
  it('freezes an all-range template rule to the original A/electrical scope without clipping personal cross-building exceptions', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: [], rules: [
      { ...rule('all-purchase', 'purchase', 'allow', ['read', 'update']), buildings: null, specialties: null },
    ] }, overrides: { ...emptyOverrides(), rules: [rule('personal-B-update', 'purchase', 'allow', ['update'])] } });
    const bytes = JSON.stringify(before);
    expect(allowed(before, 'purchase', 'read', 'A楼')).toBe(true);
    expect(allowed(before, 'purchase', 'read', 'B楼')).toBe(false);
    expect(allowed(before, 'purchase', 'update', 'B楼')).toBe(true);
    const split = splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:role' ? 'retain' : 'transfer'), ['recDutyB']);
    expect(split.transfer.effectiveAuthorization!.baseline.rules).toEqual([{ ...before.effectiveAuthorization!.baseline.rules[0], buildings: ['A楼'], specialties: ['电气'] }]);
    expect(split.transfer.effectiveAuthorization!.overrides.rules).toEqual(before.effectiveAuthorization!.overrides.rules);
    expect(allowed(split.transfer, 'purchase', 'read', 'A楼')).toBe(true);
    expect(allowed(split.transfer, 'purchase', 'read', 'B楼')).toBe(false);
    expect(allowed(split.transfer, 'purchase', 'update', 'B楼')).toBe(true);
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it.each(['professional_admin', 'building_admin'] as const)('freezes only the scope dimensions constrained by %s', role => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: [], rules: [{ ...rule('all-purchase', 'purchase', 'allow', ['read']), buildings: null, specialties: null }] }, overrides: emptyOverrides() });
    before.role = role; before.effectiveAuthorization!.baseline.nativeRole = role;
    if (role === 'professional_admin') { before.building = null; delete before.buildings; }
    else delete before.specialties;
    before.pagePaths = personalPermissionPagePaths(actor(before), authorizationPages(before.effectiveAuthorization!));
    const split = splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:base-rule:all-purchase' ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.transfer.effectiveAuthorization!.baseline.rules[0]).toMatchObject(role === 'professional_admin'
      ? { buildings: null, specialties: ['电气'] } : { buildings: ['A楼'], specialties: null });
    expect(canPerformBusinessAction(actor(split.transfer), { module: 'purchase', action: 'read', building: 'B楼', specialty: '电气' })).toBe(role === 'professional_admin');
    expect(canPerformBusinessAction(actor(split.transfer), { module: 'purchase', action: 'read', building: 'A楼', specialty: '暖通' })).toBe(role === 'building_admin');
  });
  it('does not activate a dormant out-of-scope baseline rule by removing the original role', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: [], rules: [rule('outside-read', 'purchase', 'allow', ['read'])] }, overrides: emptyOverrides() });
    const bytes = JSON.stringify(before);
    expect(allowed(before, 'purchase', 'read', 'B楼')).toBe(false);
    expect(before.pagePaths).not.toContain('/purchase-inventory-management');
    const split = splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:base-rule:outside-read' ? 'transfer' : 'retain'), ['recDutyB']);
    expect(split.transfer.effectiveAuthorization!.baseline.rules).toEqual([]);
    expect(split.transfer.pagePaths).toEqual([]);
    expect(allowed(split.transfer, 'purchase', 'read', 'B楼')).toBe(false);
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it('rejects a retained page whose dormant baseline rule would add B-building access after A-role transfer', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: 'professional_engineer', pages: ['/purchase-inventory-management'], rules: [rule('outside-read', 'purchase', 'allow', ['read'])] }, overrides: emptyOverrides() });
    const bytes = JSON.stringify(before);
    expect(allowed(before, 'purchase', 'read', 'A楼')).toBe(true);
    expect(allowed(before, 'purchase', 'read', 'B楼')).toBe(false);
    expect(() => splitHandoverPermissionGrants(before, choices(before, key => key === 'v2:role' ? 'transfer' : 'retain'), ['recDutyB'])).toThrow('页面仍依赖');
    expect(JSON.stringify(before)).toBe(bytes);
  });
  it('requires complete matching ownership and preserves the explicit empty baseline without a site-member fallback', () => {
    const before = template({ mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [] }, overrides: emptyOverrides() });
    expect(handoverPermissionGrantKeys(before)).toEqual(['v2:role']);
    expect(() => splitHandoverPermissionGrants(before, [], ['recDutyB'])).toThrow();
    const split = splitHandoverPermissionGrants(before, choices(before, () => 'shared'), ['recDutyB']);
    for (const side of [split.transfer, split.retained]) { expect(side.role).toBe('guest'); expect(side.pagePaths).toEqual([]); expect(side.effectiveAuthorization?.baseline.nativeRole).toBeNull(); }
  });
  it('rejects over-limit grant snapshots, layers and rules instead of truncating them', () => {
    const snapshot: AuthorizationGrantSnapshot = { baseline: { nativeRole: null, pages: [], rules: [] }, overrides: emptyOverrides(), scope: { building: null } };
    for (const mutate of [
      (value: AccountPermissionTemplate) => { value.effectiveAuthorization!.baseline.grantSnapshots = Array.from({ length: 9 }, () => structuredClone(snapshot)); },
      (value: AccountPermissionTemplate) => { value.effectiveAuthorization!.baseline.grantSnapshots = [{ ...snapshot, overrideLayers: Array.from({ length: 9 }, emptyOverrides) }]; },
      (value: AccountPermissionTemplate) => { value.effectiveAuthorization!.baseline.rules = Array.from({ length: 101 }, (_, i) => rule(`rule-${i}`, 'purchase', 'allow', ['read'])); },
    ]) {
      const before = source(); mutate(before); const bytes = JSON.stringify(before);
      expect(() => handoverPermissionGrantKeys(before)).toThrow(); expect(JSON.stringify(before)).toBe(bytes);
    }
  });
  it('rejects unsupported outer overrideLayers rather than silently dropping them', () => {
    const before = source();
    Object.assign(before.effectiveAuthorization!, { overrideLayers: [emptyOverrides()] });
    expect(() => handoverPermissionGrantKeys(before)).toThrow();
  });
});
