import { editAuthorizationAction, editAuthorizationPage, authorizationPageMode } from '../../client/src/pages/SystemConfiguration/authorization-editing';
import type { EffectiveAuthorization } from '../../shared/authorization-profile';

const initial = (): EffectiveAuthorization => ({ mode: 'follow', templateId: 'synthetic-role', templateVersion: 1,
  baseline: { nativeRole: 'editor', pages: ['/organization'], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } });
describe('unified authorization draft edits', () => {
  it('edits only personal overrides while following a role', () => {
    const value = initial(), result = editAuthorizationAction(value, false, { module: 'inventory', buildings: ['A楼'], specialties: ['电气'] }, 'update', 'deny', () => 'synthetic-deny');
    expect(result.baseline).toBe(value.baseline);
    expect(value.overrides.rules).toEqual([]);
    expect(result.overrides.rules).toEqual([{ id: 'synthetic-deny', module: 'inventory', actions: ['update'], effect: 'deny', buildings: ['A楼'], specialties: ['电气'] }]);
    expect(editAuthorizationAction(result, false, { module: 'inventory', buildings: ['A楼'], specialties: ['电气'] }, 'update', 'inherit', () => 'unused').overrides.rules).toEqual([]);
  });
  it('changes a template baseline without losing personal scope exceptions', () => {
    const value = initial(); value.overrides.denyPages = ['/organization'];
    const result = editAuthorizationAction(value, true, { module: 'knowledge', buildings: null, specialties: null }, 'read', 'allow', () => 'synthetic-base');
    expect(result.overrides).toBe(value.overrides);
    expect(result.baseline.rules[0].module).toBe('knowledge');
    expect(value.baseline.rules).toEqual([]);
  });
  it('page inherit removes only the selected page override and deny wins old conflicts', () => {
    const value = initial(); value.overrides = { rules: [], allowPages: ['/organization'], denyPages: ['/organization', '/nantong-base'] };
    expect(authorizationPageMode(value, '/organization')).toBe('deny');
    const result = editAuthorizationPage(value, false, '/organization', 'inherit');
    expect(result.overrides).toEqual({ rules: [], allowPages: [], denyPages: ['/nantong-base'] });
    expect(result.baseline).toBe(value.baseline);
  });
  it('does not mutate the source when a template page is denied', () => {
    const value = initial(), result = editAuthorizationPage(value, true, '/organization', 'deny');
    expect(result.baseline.pages).toEqual([]); expect(value.baseline.pages).toEqual(['/organization']);
  });
});
