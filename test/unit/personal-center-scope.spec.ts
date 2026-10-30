import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = []; let mockCursor = 0; const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: any) => { const index = mockCursor++; if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial; return [mockSlots[index], (value: any) => { mockSlots[index] = typeof value === 'function' ? value(mockSlots[index]) : value; }]; },
  useRef: (initial: any) => { const index = mockCursor++; if (!(index in mockSlots)) mockSlots[index] = { current: initial }; return mockSlots[index]; },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: any, dependencies: any[]) => { const index = mockCursor++, old = mockSlots[index]; if (!old || dependencies.some((value, at) => value !== old.dependencies[at])) { const next = { dependencies, cleanup: old?.cleanup }; mockSlots[index] = next; mockEffects.push(() => { next.cleanup?.(); next.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/api/personal-access', () => ({ createPermissionRequest: jest.fn() }));
import { isValidElement } from 'react';
import { createPermissionCatalog } from '../../shared/permission-catalog';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { alreadyOwnsPermission, personalActionCoverage, personalReadablePages } from '../../client/src/pages/PersonalCenter/permission-request.logic';
import { PermissionRequestForm } from '../../client/src/pages/PersonalCenter/PermissionRequestForm';
const catalog = createPermissionCatalog();
const principal: AccessPrincipal = { role: 'professional_engineer', purchaseBuilding: null, buildings: ['A楼'], specialties: ['电气'], effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [{ id: 'synthetic', module: 'inventory', actions: ['create'], effect: 'allow', buildings: ['A楼'], specialties: ['电气'] }] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
function nodes(node: ReactNode): ReactElement<any>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : []; }
function words(node: ReactNode): string { return typeof node === 'string' ? node : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : ''; }
function render<T>(fn: () => T) { mockCursor = 0; const result = fn(); mockEffects.splice(0).forEach(effect => effect()); return result; }
function cleanup() { mockSlots.forEach(slot => slot?.cleanup?.()); mockSlots.length = 0; mockEffects.length = 0; }
describe('personal permission request scope boundaries', () => {
  beforeEach(cleanup); afterEach(cleanup);
  it('reports exact allowed pairs and never turns an action grant into page read', () => {
    const coverage = personalActionCoverage(principal, 'inventory', 'create', true);
    expect(coverage.ranges).toEqual(['A楼 · 电气']); expect(coverage.allowed).toBe(1);
    expect(personalReadablePages(principal)).not.toContain(catalog.pages.find(page => page.modules.some(module => module.id === 'inventory'))!.path);
    expect(alreadyOwnsPermission(principal, { kind: 'action', module: 'inventory', action: 'create', buildings: ['A楼'], specialties: ['电气'] })).toBe(true);
    expect(alreadyOwnsPermission(principal, { kind: 'action', module: 'inventory', action: 'create', buildings: ['B楼'], specialties: ['电气'] })).toBe(false);
    expect(alreadyOwnsPermission(principal, { kind: 'action', module: 'inventory', action: 'create', buildings: null, specialties: null })).toBe(false);
  });
  it('defaults scoped requests to empty explicit selections without any source suggestion', () => {
    const props = { catalog, onSubmitted() {}, prefill: { key: 1, permission: { kind: 'action' as const, module: 'inventory' as const, action: 'create' as const, buildings: null, specialties: null } } };
    const show = () => render(() => PermissionRequestForm(props)); show(); const tree = show();
    expect(nodes(tree).find(node => node.props.title === '楼栋范围')?.props.value).toEqual([]);
    expect(nodes(tree).find(node => node.props.title === '专业范围')?.props.value).toEqual([]);
    nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children) === '添加申请项')!.props.onClick();
    expect(words(show())).toContain('请至少选择一个楼栋和专业');
  });
  it('uses only explicit account suggestions and blocks an already-owned scope', () => {
    const props = { catalog, principal, suggestedScopes: { buildings: ['A楼' as const], specialties: ['电气' as const] }, onSubmitted() {}, prefill: { key: 1, permission: { kind: 'action' as const, module: 'inventory' as const, action: 'create' as const, buildings: null, specialties: null } } };
    const show = () => render(() => PermissionRequestForm(props)); show(); const tree = show();
    expect(nodes(tree).find(node => node.props.title === '楼栋范围')?.props.value).toEqual(['A楼']);
    expect(nodes(tree).find(node => node.props.title === '专业范围')?.props.value).toEqual(['电气']);
    expect(words(tree)).toContain('当前已拥有的权限'); expect(words(tree)).toContain('A楼 · 电气');
    nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children) === '添加申请项')!.props.onClick();
    expect(words(show())).toContain('此项所选范围已具备权限，无需重复申请');
  });
  it('preserves a typed reason when a new missing-permission shortcut changes the selection', () => {
    let prefill = { key: 1, permission: { kind: 'page' as const, path: '/nantong-base' } };
    const show = () => render(() => PermissionRequestForm({ catalog, onSubmitted() {}, prefill }));
    show(); nodes(show()).find(node => node.type === 'textarea')!.props.onChange({ target: { value: '仍需保留的合成理由' } });
    prefill = { key: 2, permission: { kind: 'page', path: '/monthly-schedule' } }; show();
    expect(nodes(show()).find(node => node.type === 'textarea')!.props.value).toBe('仍需保留的合成理由');
  });
});
