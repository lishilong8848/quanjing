import { BUILDING_ADMIN_BUILDINGS } from '../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '../../shared/professional-access';
import { canPerformBusinessAction, validPersonalRules, type PersonalPermissionRule } from '../../shared/business-permissions';
import type { EffectiveAuthorization } from '../../shared/authorization-profile';
import { editAuthorizationAction } from '../../client/src/pages/SystemConfiguration/authorization-editing';
import { personalPermissionMode } from '../../client/src/pages/SystemConfiguration/personal-permission-editing';

const scope = { module: 'inventory' as const, buildings: ['A楼', 'C楼'] as PersonalPermissionRule['buildings'], specialties: ['电气', '暖通'] as PersonalPermissionRule['specialties'] };
const deny: PersonalPermissionRule = { id: 'wide', module: 'inventory', actions: ['read', 'update'], effect: 'deny', buildings: null, specialties: null };
const authorization = (rules: PersonalPermissionRule[]): EffectiveAuthorization => ({
  mode: 'follow', templateId: 'synthetic-inventory-role', templateVersion: 1,
  baseline: { nativeRole: null, pages: [], rules: [{ ...deny, id: 'baseline-inventory', effect: 'allow' }] },
  overrides: { rules, allowPages: [], denyPages: [] },
});
const allowed = (rules: PersonalPermissionRule[], building: string, specialty: string, action: 'read'|'update' = 'read') => canPerformBusinessAction({ role: 'guest', effectiveAuthorization: authorization(rules) }, { module: 'inventory', action, building, specialty });
const edit = (rules: PersonalPermissionRule[], selection: Parameters<typeof editAuthorizationAction>[2], action: Parameters<typeof editAuthorizationAction>[3], mode: Parameters<typeof editAuthorizationAction>[4], id: () => string) => {
  const value = authorization(rules);
  const result = editAuthorizationAction(value, false, selection, action, mode, id);
  expect(result.baseline).toBe(value.baseline);
  expect(value.overrides.rules).toBe(rules);
  return result.overrides.rules;
};

describe('统一权限编辑器的个人例外按多楼栋多专业生效', () => {
  let nextId = 0;
  const id = () => `synthetic-rule-${++nextId}`;
  beforeEach(() => { nextId = 0; });
  it('多选内统一允许，保留范围外限制和其他操作', () => {
    const result = edit([deny], scope, 'read', 'allow', id);
    expect(validPersonalRules(result)).toBe(true);
    for (const building of BUILDING_ADMIN_BUILDINGS) for (const specialty of PROFESSIONAL_SPECIALTIES) {
      expect(allowed(result, building, specialty)).toBe(['A楼', 'C楼'].includes(building) && ['电气', '暖通'].includes(specialty));
      expect(allowed(result, building, specialty, 'update')).toBe(false);
    }
    expect(personalPermissionMode(result, scope, 'read')).toBe('allow');
  });
  it('选中范围恢复继承，不清空其他范围的个人规则', () => {
    const result = edit([deny], scope, 'read', 'inherit', id);
    expect(personalPermissionMode(result, scope, 'read')).toBe('inherit');
    expect(allowed(result, 'A楼', '电气')).toBe(true);
    expect(allowed(result, 'B楼', '电气')).toBe(false);
    expect(allowed(result, 'C楼', '消防')).toBe(false);
    expect(allowed(result, 'C楼', '暖通', 'update')).toBe(false);
  });
  it('不同规则不产生跨行组合，显示混合配置，限制优先', () => {
    const rules: PersonalPermissionRule[] = [
      { ...deny, id: 'a', actions: ['read'], effect: 'allow', buildings: ['A楼'], specialties: ['电气'] },
      { ...deny, id: 'c', actions: ['read'], buildings: ['C楼'], specialties: ['暖通'] },
    ];
    expect(personalPermissionMode(rules, scope, 'read')).toBe('mixed');
    const result = edit(rules, scope, 'read', 'deny', id);
    expect(personalPermissionMode(result, scope, 'read')).toBe('deny');
    expect(validPersonalRules(result)).toBe(true);
    expect(allowed(result, 'A楼', '电气')).toBe(false);
  });
  it('全范围恢复继承，非范围业务不生成楼栋专业权限', () => {
    expect(edit([deny], { ...scope, buildings: null, specialties: null }, 'read', 'inherit', id)).toEqual([{ ...deny, actions: ['update'] }]);
    const result = edit([], { module: 'meetings', buildings: ['A楼'], specialties: ['电气'] }, 'delete', 'deny', id);
    expect(result[0]).toMatchObject({ buildings: null, specialties: null });
    expect(validPersonalRules(result)).toBe(true);
  });
  it('拒绝空范围、未知动作与超限拆分，原规则不变', () => {
    expect(() => edit([deny], { ...scope, buildings: [] }, 'read', 'allow', id)).toThrow();
    expect(() => edit([], { ...scope, module: 'tools' }, 'delete', 'deny', id)).toThrow();
    const rules = Array.from({ length: 100 }, (_, index) => ({ ...deny, id: `old-${index}`, module: 'meetings' as const }));
    expect(() => edit(rules, scope, 'read', 'allow', id)).toThrow('100');
    expect(rules).toHaveLength(100);
    expect(deny).toMatchObject({ actions: ['read', 'update'], buildings: null });
  });
});
