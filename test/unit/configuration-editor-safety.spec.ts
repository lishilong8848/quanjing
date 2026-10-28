import type { ReactElement, ReactNode } from 'react';
import type { AccessConfigurationResponse, ManagedAccount } from '../../shared/access-configuration.interface';
import type { AuthorizationRoleList, EffectiveAuthorization } from '../../shared/authorization-profile';
import type { PersonnelOverview, PersonnelReadOnlyPreview } from '../../shared/personnel-preview.interface';
import { BUILDING_ADMIN_BUILDINGS } from '../../shared/access-control.interface';
import { canPerformBusinessAction } from '../../shared/business-permissions';
import { editAuthorizationAction } from '../../client/src/pages/SystemConfiguration/authorization-editing';

// Exercise the real component callbacks and retained state; browser focus/paint is a separate acceptance check.
const mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffectsEnabled = false;
const mockPendingEffects = new Map<number, () => void>();
const mockFrames = new Map<number, FrameRequestCallback>();
let mockFrameId = 0;
const originalFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
const originalCancelFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => {
    const slot = mockCursor++;
    if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }];
  },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useMemo: (factory: () => unknown, dependencies: unknown[]) => {
    const slot = mockCursor++, previous = mockSlots[slot] as { value: unknown; dependencies: unknown[] } | undefined;
    if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) mockSlots[slot] = { value: factory(), dependencies };
    return (mockSlots[slot] as { value: unknown }).value;
  },
  useDeferredValue: (value: unknown) => value,
  useEffect: (factory: () => void | (() => void), dependencies: unknown[]) => {
    const slot = mockCursor++, previous = mockSlots[slot] as { dependencies: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
      const state = { dependencies, cleanup: previous?.cleanup }; mockSlots[slot] = state;
      if (mockEffectsEnabled) mockPendingEffects.set(slot, () => { state.cleanup?.(); state.cleanup = factory() || undefined; });
    }
  },
}));
jest.mock('../../shared/permission-matrix', () => { const actual = jest.requireActual('../../shared/permission-matrix'); return { ...actual, buildPermissionMatrix: jest.fn(actual.buildPermissionMatrix) }; });
jest.mock('../../client/src/pages/SystemConfiguration/api', () => ({ loadAccountAuthorization: jest.fn(), previewAccountAuthorization: jest.fn(), saveAccount: jest.fn(), loadPersonnelPreview: jest.fn() }));
jest.mock('../../client/src/pages/SystemConfiguration/permission-matrix.css', () => ({}));

import { isValidElement } from 'react';
import { AccountEditor } from '../../client/src/pages/SystemConfiguration/AccountEditor';
import { PermissionEditor } from '../../client/src/pages/SystemConfiguration/PermissionEditor';
import { PermissionMatrixPanel } from '../../client/src/pages/SystemConfiguration/PermissionMatrixPanel';
import { PermissionComparison, PersonnelPreviewPanel, permissionTemplateSummary } from '../../client/src/pages/SystemConfiguration/PersonnelPreviewPanel';
import { PersonnelRecordSelect } from '../../client/src/pages/SystemConfiguration/PersonnelRecordSelect';
import { loadPersonnelPreview, previewAccountAuthorization, saveAccount } from '../../client/src/pages/SystemConfiguration/api';
import { buildPermissionMatrix } from '../../shared/permission-matrix';

function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<any>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function words(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return isValidElement<any>(node) ? words(node.props.children) : '';
}
const button = (tree: ReactNode, label: string) => nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children) === label)!;
const field = (tree: ReactNode, label: string) => nodes(tree).find(node => node.props['aria-label'] === label)!;
const editor = (tree: ReactNode) => nodes(tree).find(node => node.type === PermissionEditor)!;
const render = <T,>(factory: () => T): T => { mockCursor = 0; return factory(); };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function enableMatrixEffects() {
  mockEffectsEnabled = true; jest.useFakeTimers();
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: jest.fn((callback: FrameRequestCallback) => { const id = ++mockFrameId; mockFrames.set(id, callback); return id; }) });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: jest.fn((id: number) => { mockFrames.delete(id); }) });
}
function effects() { const pending = [...mockPendingEffects.values()]; mockPendingEffects.clear(); for (const effect of pending) effect(); }
function frames() { const pending = [...mockFrames.values()]; mockFrames.clear(); for (const callback of pending) callback(0); }
function completeMatrix(draw: () => ReactElement<any>) { render(draw); effects(); frames(); jest.runAllTimers(); return render(draw); }
const empty = () => ({ rules: [], allowPages: [], denyPages: [] });
const original = (): EffectiveAuthorization => ({
  mode: 'follow', templateId: 'synthetic-role-a', templateVersion: 2,
  baseline: { nativeRole: null, pages: ['/nantong-base'], rules: [], grantSnapshots: [{
    baseline: { nativeRole: 'professional_engineer', pages: ['/inventory-management'], rules: [] },
    overrides: empty(), overrideLayers: [{ ...empty(), denyPages: ['/operations-kb'] }],
    scope: { building: 'A楼', buildings: ['A楼'], specialties: ['电气'] },
  }] },
  overrides: { ...empty(), denyPages: ['/meeting-management'] },
});
function fixture() {
  const authorization = original();
  const account: ManagedAccount = { id: 'synthetic-account', name: '合成人员', kind: 'feishu', openId: 'ou_synthetic', role: 'guest', building: null, enabled: true, deleted: false, version: 3, source: 'configuration', effectiveAuthorization: authorization };
  const data: AccessConfigurationResponse = { revision: 7, appId: 'cli_synthetic', accounts: [account], cardRules: [], audit: [] };
  const roles: AuthorizationRoleList = { revision: 7, roles: [
    { id: 'synthetic-role-a', name: '合成角色甲', description: '', enabled: true, builtin: false, version: 2, followerCount: 1, policy: authorization.baseline },
    { id: 'synthetic-role-b', name: '合成角色乙', description: '', enabled: true, builtin: false, version: 1, followerCount: 0, policy: { nativeRole: null, pages: ['/architecture'], rules: [] } },
  ] };
  return { account, data, roles, people: [], onClose: jest.fn(), onSaved: jest.fn() };
}

describe('unified configuration editor safety boundaries', () => {
  beforeEach(() => { mockSlots.length = 0; mockCursor = 0; mockEffectsEnabled = false; mockPendingEffects.clear(); mockFrames.clear(); jest.clearAllMocks(); (buildPermissionMatrix as jest.Mock).mockImplementation(jest.requireActual('../../shared/permission-matrix').buildPermissionMatrix); });
  afterEach(() => {
    for (const slot of mockSlots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup?: () => void }).cleanup?.();
    jest.useRealTimers();
    if (originalFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', originalFrame); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalCancelFrame) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancelFrame); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  it('detaches the complete baseline, layered grants, scopes and personal exceptions without a live template link', () => {
    const props = fixture(), tree = render(() => AccountEditor(props));
    button(tree, '转为独立配置').props.onClick();
    const value = editor(render(() => AccountEditor(props))).props.value as EffectiveAuthorization;
    expect(value).toEqual({ mode: 'independent', baseline: props.account.effectiveAuthorization!.baseline, overrides: props.account.effectiveAuthorization!.overrides });
    expect(value.baseline).not.toBe(props.account.effectiveAuthorization!.baseline);
    expect(value.baseline.grantSnapshots![0].scope).not.toBe(props.account.effectiveAuthorization!.baseline.grantSnapshots![0].scope);
    expect(value.overrides).not.toBe(props.account.effectiveAuthorization!.overrides);
    props.roles = { ...props.roles, roles: props.roles.roles.map(role => ({ ...role, version: role.version + 1, policy: { nativeRole: null, pages: [], rules: [] } })) };
    expect(editor(render(() => AccountEditor(props))).props.value).toEqual(value);
  });
  it('explicitly switching templates keeps personal exceptions and replaces, rather than unions, the old baseline', () => {
    const props = fixture(), tree = render(() => AccountEditor(props));
    field(tree, '选择角色模板').props.onChange({ target: { value: 'synthetic-role-b' } });
    const value = editor(render(() => AccountEditor(props))).props.value as EffectiveAuthorization;
    expect(value).toMatchObject({ mode: 'follow', templateId: 'synthetic-role-b', templateVersion: 1 });
    expect(value.baseline).toEqual(props.roles.roles[1].policy);
    expect(value.baseline).not.toHaveProperty('grantSnapshots');
    expect(value.overrides).toEqual(props.account.effectiveAuthorization!.overrides);
    expect(saveAccount).not.toHaveBeenCalled();
  });
  it('personal allow is additive; restricting inherited all-building read requires denying the other buildings', () => {
    const base: EffectiveAuthorization = { mode: 'follow', templateId: 'synthetic-all-buildings', templateVersion: 1,
      baseline: { nativeRole: null, pages: [], rules: [{ id: 'all-read', module: 'inventory', effect: 'allow', actions: ['read'], buildings: null, specialties: null }] }, overrides: empty() };
    const allowA = editAuthorizationAction(base, false, { module: 'inventory', buildings: ['A楼'], specialties: null }, 'read', 'allow', () => 'allow-a');
    const canRead = (value: EffectiveAuthorization, building: string) => canPerformBusinessAction({ role: 'guest', effectiveAuthorization: value }, { module: 'inventory', action: 'read', building, specialty: '电气' });
    expect(canRead(allowA, 'A楼')).toBe(true); expect(canRead(allowA, 'B楼')).toBe(true);
    const onlyA = editAuthorizationAction(base, false, { module: 'inventory', buildings: BUILDING_ADMIN_BUILDINGS.filter(building => building !== 'A楼'), specialties: null }, 'read', 'deny', () => 'deny-others');
    for (const building of BUILDING_ADMIN_BUILDINGS) expect(canRead(onlyA, building)).toBe(building === 'A楼');
    expect(onlyA.baseline).toBe(base.baseline); expect(base.overrides.rules).toEqual([]);
  });
  it('retains the draft but blocks save when the account changes during a configuration refresh', () => {
    const props = fixture(), tree = render(() => AccountEditor(props));
    const draft = { ...editor(tree).props.value, overrides: { ...empty(), denyPages: ['/meeting-management', '/operations-kb'] } };
    editor(tree).props.onChange(draft);
    props.data = { ...props.data, revision: 8, accounts: [{ ...props.account, version: 4 }] };
    const updated = render(() => AccountEditor(props));
    expect(editor(updated).props.value).toBe(draft);
    expect(words(updated)).toContain('该账号已发生变化');
    expect(nodes(updated).find(node => node.props.type === 'submit')!.props.disabled).toBe(true);
    expect(saveAccount).not.toHaveBeenCalled();
  });
  it('preserves all draft layers and the mutation identity after a server conflict; closing is not automatic', async () => {
    const props = fixture();
    (previewAccountAuthorization as jest.Mock).mockResolvedValue({ revision: 7, accountId: props.account.id, before: original(), after: original(), sessionWillBeRevoked: true });
    (saveAccount as jest.Mock).mockRejectedValue(Object.assign(new Error('配置版本已变化'), { status: 409 }));
    button(render(() => AccountEditor(props)), '核对权限').props.onClick(); await flush();
    let tree = render(() => AccountEditor(props));
    const check = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
    check.props.onChange({ target: { checked: true } });
    tree = render(() => AccountEditor(props));
    nodes(tree).find(node => node.type === 'form')!.props.onSubmit({ preventDefault: jest.fn() }); await flush();
    tree = render(() => AccountEditor(props));
    expect(words(tree)).toContain('配置版本已变化');
    expect(editor(tree).props.value).toEqual(original());
    expect(props.onClose).not.toHaveBeenCalled(); expect(props.onSaved).not.toHaveBeenCalled();
    const first = (saveAccount as jest.Mock).mock.calls[0][0];
    expect(first.authorizationOverrides).toEqual(original().overrides);
    nodes(tree).find(node => node.type === 'form')!.props.onSubmit({ preventDefault: jest.fn() }); await flush();
    expect((saveAccount as jest.Mock).mock.calls[1][0].clientMutationId).toBe(first.clientMutationId);
  });
  it('matrix detail switching and closing leave filters and the underlying rows intact without a write', () => {
    enableMatrixEffects();
    const props = fixture(), onEditAccount = jest.fn();
    const draw = () => PermissionMatrixPanel({ data: props.data, templates: props.roles.roles, onEditAccount });
    field(render(draw), '搜索矩阵人员或角色').props.onChange({ target: { value: '合成人员' } });
    let tree = completeMatrix(draw), cells = nodes(tree).filter(node => node.props['data-matrix-cell']);
    const trigger = { getBoundingClientRect: () => ({}), isConnected: true, focus: jest.fn() };
    cells[0].props.onClick({ currentTarget: trigger }); tree = render(draw);
    expect(tree.props.open).toBe(true);
    cells = nodes(tree).filter(node => node.props['data-matrix-cell']);
    cells[1].props.onClick({ currentTarget: trigger }); tree = render(draw);
    expect(field(tree, '搜索矩阵人员或角色').props.value).toBe('合成人员');
    expect(nodes(tree).filter(node => node.props['data-matrix-cell'])[1].props['aria-expanded']).toBe(true);
    tree.props.onOpenChange(false); tree = render(draw);
    expect(tree.props.open).toBe(false); expect(field(tree, '搜索矩阵人员或角色').props.value).toBe('合成人员');
    expect(onEditAccount).not.toHaveBeenCalled(); expect(saveAccount).not.toHaveBeenCalled();
  });
  it('handover preview returns to the same selected people and back to the cached preview without another request', async () => {
    const overview = { directoryVersion: 'synthetic-1', configurationRevision: 7, people: [
      { person: { id: 'from', name: '合成前任', active: true } }, { person: { id: 'to', name: '合成接任', active: true } },
    ], duties: [] } as unknown as PersonnelOverview;
    const result = { from: overview.people[0].person, to: overview.people[1].person, conflicts: [], warnings: [], permissions: [], pending: [], excluded: [], checks: [] } as unknown as PersonnelReadOnlyPreview;
    (loadPersonnelPreview as jest.Mock).mockResolvedValue(result);
    const draw = () => PersonnelPreviewPanel({ overview, initialFrom: 'from', revision: 7, onRefresh: jest.fn(), onBack: jest.fn() });
    let tree = render(draw);
    nodes(tree).find(node => node.type === PersonnelRecordSelect && node.props.label === '接任人员')!.props.onChange('to');
    button(render(draw), '生成预览').props.onClick(); await flush(); tree = render(draw);
    button(tree, '返回人员选择').props.onClick(); tree = render(draw);
    expect(nodes(tree).filter(node => node.type === PersonnelRecordSelect).map(node => node.props.value)).toEqual(['from', 'to']);
    button(tree, '返回预览').props.onClick(); tree = render(draw);
    expect(button(tree, '返回人员选择')).toBeDefined(); expect(loadPersonnelPreview).toHaveBeenCalledTimes(1);
    expect(saveAccount).not.toHaveBeenCalled();
  });
  it('describes V2 snapshots instead of the guest transport role or an invented all-campus scope', () => {
    const template = { role: 'guest' as const, building: null, sourceVersion: 3, pagePaths: [], effectiveAuthorization: { ...original(), mode: 'independent' as const } };
    expect(permissionTemplateSummary(template)).toEqual({ label: '独立权限（无默认角色）', scope: '规则范围见逐项权限' });
    expect(permissionTemplateSummary({ ...template, effectiveAuthorization: original() }).label).toBe('角色权限快照（无默认角色）');
    expect(permissionTemplateSummary({ role: 'professional_engineer', building: 'B楼', specialties: ['电气'], sourceVersion: 1, pagePaths: [] }).scope).toBe('B楼 · 电气');
    const comparison = PermissionComparison({ value: { sourceAccountId: 'source', targetAccountId: 'target', source: template, before: template, after: template } as PersonnelReadOnlyPreview['permissions'][number] });
    expect(words(comparison)).toContain('独立权限（无默认角色）');
    expect(words(comparison)).toContain('当前单据的申请归属、办理职责和状态要求');
  });
  it('matrix popover and handover comparison expose each independent read module without duplicating single-module reads', () => {
    enableMatrixEffects();
    const props = fixture();
    const effective: EffectiveAuthorization = { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [{ id: 'schedule-only', module: 'monthly_schedule', effect: 'allow', actions: ['read'], buildings: null, specialties: null }] }, overrides: empty() };
    props.data = { ...props.data, accounts: [{ ...props.account, effectiveAuthorization: effective }] };
    const draw = () => PermissionMatrixPanel({ data: props.data });
    let tree = completeMatrix(draw);
    field(tree, '合成人员 · 人员保障权限详情').props.onClick({ currentTarget: { getBoundingClientRect: () => ({}) } });
    tree = render(draw);
    const detail = nodes(tree).find(node => node.props.row && node.props.column && node.props.onCloseFocus)!;
    const detailTree = (detail.type as (props: any) => ReactNode)(detail.props);
    expect(words(detailTree)).toContain('排班总览 · 查看');
    expect(words(detailTree)).toContain('考勤与工时 · 查看');
    expect(words(detailTree)).toContain('人员排班明细 · 查看');
    expect(words(detailTree)).toContain('排班人员详细资料 · 查看');
    expect(words(detailTree)).toContain('变更记录附件 · 查看');
    expect(words(detailTree)).toContain('未授权查看');
    const template = { role: 'guest' as const, building: null, sourceVersion: 1, pagePaths: ['/monthly-schedule'], effectiveAuthorization: effective };
    const comparison = PermissionComparison({ value: { sourceAccountId: 'source', targetAccountId: 'target', source: template, before: template, after: template } as PersonnelReadOnlyPreview['permissions'][number] });
    expect(words(comparison)).toContain('排班总览 · 查看'); expect(words(comparison)).toContain('考勤与工时 · 查看');
    expect(words(comparison)).toContain('未授权查看'); expect(words(comparison)).not.toContain('运维知识库 · 查看');
  });
  it('paints a pending state before computing and publishes only the complete visible-page batch', () => {
    enableMatrixEffects(); (buildPermissionMatrix as jest.Mock).mockReturnValue([]);
    const props = fixture(); props.data = { ...props.data, accounts: Array.from({ length: 25 }, (_, index) => ({ ...props.account, id: `synthetic-${index}`, name: `合成人员${String(index).padStart(2, '0')}` })) };
    const draw = () => PermissionMatrixPanel({ data: props.data });
    let tree = render(draw);
    expect(words(tree)).toContain('正在计算权限'); expect(buildPermissionMatrix).not.toHaveBeenCalled();
    effects(); expect(buildPermissionMatrix).not.toHaveBeenCalled();
    frames(); expect(buildPermissionMatrix).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers(); tree = render(draw);
    expect(buildPermissionMatrix).toHaveBeenCalledTimes(1); expect(nodes(tree).some(node => node.props['data-matrix-cell'])).toBe(false);
    jest.runAllTimers(); tree = render(draw);
    expect(buildPermissionMatrix).toHaveBeenCalledTimes(20); expect(words(tree)).not.toContain('正在计算权限');
    expect(nodes(tree).some(node => node.props['data-matrix-cell'])).toBe(true);
    effects(); frames(); jest.runAllTimers(); expect(buildPermissionMatrix).toHaveBeenCalledTimes(20);
  });
  it('cancels an old partial calculation on filter change and refuses a delayed callback even before effect cleanup', () => {
    enableMatrixEffects(); (buildPermissionMatrix as jest.Mock).mockReturnValue([]);
    const timeout = jest.spyOn(globalThis, 'setTimeout');
    const props = fixture(); props.data = { ...props.data, accounts: ['甲', '乙', '丙'].map(name => ({ ...props.account, id: `synthetic-${name}`, name: `合成${name}` })) };
    const draw = () => PermissionMatrixPanel({ data: props.data });
    render(draw); effects(); frames(); jest.runOnlyPendingTimers();
    const late = timeout.mock.calls[timeout.mock.calls.length - 1][0] as () => void;
    let tree = render(draw); field(tree, '搜索矩阵人员或角色').props.onChange({ target: { value: '合成乙' } }); tree = render(draw);
    const count = (buildPermissionMatrix as jest.Mock).mock.calls.length; late(); expect(buildPermissionMatrix).toHaveBeenCalledTimes(count);
    tree = completeMatrix(draw); expect(words(tree)).toContain('合成乙');
    const names = nodes(tree).filter(node => node.props['data-matrix-cell']).map(node => node.props['aria-label']);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(name => name.startsWith('合成乙'))).toBe(true);
    late(); expect(buildPermissionMatrix).toHaveBeenCalledTimes(count + 1); timeout.mockRestore();
  });
  it('invalidates completed rows on revision change and lets only the new account snapshot become visible', () => {
    enableMatrixEffects(); (buildPermissionMatrix as jest.Mock).mockReturnValue([]);
    const props = fixture(), draw = () => PermissionMatrixPanel({ data: props.data });
    let tree = completeMatrix(draw); expect(nodes(tree).some(node => node.props['data-matrix-cell'])).toBe(true);
    props.data = { ...props.data, revision: 8, accounts: [{ ...props.account, version: 4, name: '新版合成人员' }] };
    tree = render(draw); expect(words(tree)).toContain('正在计算权限'); expect(nodes(tree).some(node => node.props['data-matrix-cell'])).toBe(false);
    tree = completeMatrix(draw); expect(buildPermissionMatrix).toHaveBeenCalledTimes(2);
    const cell = nodes(tree).find(node => node.props['data-matrix-cell'])!; expect(cell.props['aria-label']).toContain('新版合成人员');
    cell.props.onClick({ currentTarget: { getBoundingClientRect: () => ({}) } }); tree = render(draw);
    expect(nodes(tree).find(node => node.props.row && node.props.column)!.props.row.subject.account.version).toBe(4);
  });
});
