import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = []; let mockCursor = 0; const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: any) => { const i = mockCursor++; if (!(i in mockSlots)) mockSlots[i] = typeof initial === 'function' ? initial() : initial; return [mockSlots[i], (next: any) => { mockSlots[i] = typeof next === 'function' ? next(mockSlots[i]) : next; }]; },
  useRef: (initial: any) => { const i = mockCursor++; return mockSlots[i] ||= { current: initial }; },
  useMemo: (factory: () => any, deps: any[]) => { const i = mockCursor++, previous = mockSlots[i]; if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) mockSlots[i] = { value: factory(), deps }; return mockSlots[i].value; },
  useCallback: (value: any, deps: any[]) => { const i = mockCursor++, previous = mockSlots[i]; if (!previous || deps.some((item, at) => !Object.is(item, previous.deps[at]))) mockSlots[i] = { value, deps }; return mockSlots[i].value; },
  useEffect: (effect: () => any, deps: any[]) => { const i = mockCursor++, previous = mockSlots[i]; if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) { const item = { deps, cleanup: previous?.cleanup }; mockSlots[i] = item; mockEffects.push(() => { item.cleanup?.(); item.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/pages/SystemConfiguration/api', () => ({ loadAccountAuthorization: jest.fn(), previewAccountAuthorization: jest.fn(), saveAccount: jest.fn(), previewAuthorizationRole: jest.fn(), saveAuthorizationRole: jest.fn() }));
jest.mock('../../client/src/api/personal-access', () => ({ listPermissionRequests: jest.fn(), reviewPermissionRequest: jest.fn(), listAdminArchiveCorrections: jest.fn(), reviewArchiveCorrection: jest.fn() }));
import { isValidElement } from 'react';
import { AccountEditor } from '../../client/src/pages/SystemConfiguration/AccountEditor';
import { RolesPanel } from '../../client/src/pages/SystemConfiguration/RolesPanel';
import { PermissionRequestsPanel } from '../../client/src/pages/SystemConfiguration/PermissionRequestsPanel';
import { ArchiveCorrectionsPanel } from '../../client/src/pages/SystemConfiguration/ArchiveCorrectionsPanel';
import { PermissionRequestList } from '../../client/src/pages/PersonalCenter/PermissionRequestList';
import { PermissionEditor } from '../../client/src/pages/SystemConfiguration/PermissionEditor';
import { ConfigurationNavigation, CONFIGURATION_GROUPS } from '../../client/src/pages/SystemConfiguration/ConfigurationNavigation';
import { followTemplate, groupLinkedAccounts, synchronizedAccounts, mergeVersionedRows, filterConfigurationAudit, auditExportRows } from '../../client/src/pages/SystemConfiguration/configuration-helpers';
import { requestedPermissionState } from '../../client/src/pages/SystemConfiguration/RequestedPermissionSummary';
import { permissionRequestExport, archiveCorrectionExport } from '../../client/src/pages/SystemConfiguration/request-export';
import { listPermissionRequests, reviewPermissionRequest, listAdminArchiveCorrections, reviewArchiveCorrection } from '../../client/src/api/personal-access';
import { previewAuthorizationRole } from '../../client/src/pages/SystemConfiguration/api';

const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
const words = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : '';
const button = (tree: ReactNode, label: string) => nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children) === label)!;
const render = <T,>(factory: () => T): T => { mockCursor = 0; const value = factory(); mockEffects.splice(0).forEach(effect => effect()); return value; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function cleanup() { mockSlots.forEach(slot => slot?.cleanup?.()); mockSlots.length = 0; mockEffects.length = 0; mockCursor = 0; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const overrides = () => ({ rules: [{ id: 'synthetic-allow', module: 'inventory', effect: 'allow', actions: ['read'], buildings: ['B楼'], specialties: null }], allowPages: [], denyPages: ['/meeting-management'] });
const policy = () => ({ nativeRole: null, pages: [], rules: [] });
const template = () => ({ id: 'role-synthetic', name: '合成角色', description: '', policy: policy(), version: 1, builtin: false, enabled: true, followerCount: 1 });
const row = () => ({ id: 'request-synthetic', accountId: 'account-synthetic', applicantName: '合成人员', version: 1, status: 'pending', permissions: [{ kind: 'page', path: '/nantong-base' }], reason: '工作需要', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z' });

describe('configuration improvements real callbacks and pure boundaries', () => {
  beforeEach(() => { cleanup(); jest.clearAllMocks(); }); afterEach(cleanup);
  it('keeps follow exceptions but drops independent grants when switching to a template', () => {
    const own = { mode: 'independent', baseline: policy(), overrides: overrides() } as any, target = template() as any;
    expect(followTemplate(own, target).overrides).toEqual({ rules: [], allowPages: [], denyPages: [] });
    const followed = followTemplate({ ...own, mode: 'follow' }, target);
    expect(followed.overrides).toEqual(own.overrides); expect(followed.overrides).not.toBe(own.overrides);
    expect(own.overrides.rules).toHaveLength(1);
  });
  it('real account mode selection shows before/after while not mixing independent exceptions', () => {
    const authorization = { mode: 'independent', baseline: policy(), overrides: overrides() } as any;
    const account = { id: 'a', name: '合成人员', role: 'guest', kind: 'feishu', openId: 'ou_synthetic', building: null, enabled: true, deleted: false, version: 1, effectiveAuthorization: authorization } as any;
    const props = { account, data: { revision: 1, appId: 'cli_synthetic', accounts: [account], cardRules: [], audit: [] }, people: [], roles: { revision: 1, roles: [template()] }, onClose: jest.fn(), onSaved: jest.fn() } as any;
    let tree = render(() => AccountEditor(props));
    nodes(tree).find(node => node.props['aria-label'] === '选择角色模板')!.props.onChange({ target: { value: 'role-synthetic' } }); tree = render(() => AccountEditor(props));
    expect(words(tree)).toContain('原独立规则未带入新角色');
    const editor = nodes(tree).find(node => node.type === PermissionEditor && node.props.label === undefined)!;
    expect(editor.props.value.overrides.rules).toEqual([]); expect(editor.props.value.mode).toBe('follow'); expect(props.onSaved).not.toHaveBeenCalled();
  });
  it('groups only verified application/person identity and retains each login state', () => {
    const one = { id: 'f', name: '同名', kind: 'feishu', personnelIdentity: 'identity', siteMember: true, appId: 'app', enabled: true } as any;
    const two = { ...one, id: 'p', kind: 'local', loginMethod: 'personnel-password', personnelAppId: 'app', appId: undefined, personnelActive: true, enabled: false };
    const stranger = { ...one, id: 'x', personnelIdentity: undefined }, external = { ...one, id: 'e', external: true }, otherApp = { ...one, id: 'o', appId: 'other' };
    const groups = groupLinkedAccounts([one, two, stranger, external, otherApp], [one, two, stranger, external, otherApp], 'app');
    expect(groups).toHaveLength(4); expect(groups[0].accounts.map(item => item.id)).toEqual(['f', 'p']); expect(groups[0].accounts[1].enabled).toBe(false);
    expect(synchronizedAccounts(one, [one, two, { ...two, id: 'gone', deleted: true }, { ...two, id: 'inactive', personnelActive: false }, otherApp], 'app').map(item => item.id)).toEqual(['p']);
  });
  it('scope status reports missing requested buildings without broadening grants', () => {
    const principal = { role: 'guest', purchaseBuilding: null, effectiveAuthorization: { mode: 'independent', baseline: policy(), overrides: overrides() } } as any;
    const result = requestedPermissionState(principal, { kind: 'action', module: 'inventory', action: 'read', buildings: ['A楼', 'B楼'], specialties: ['电气'] });
    expect(result.missing).toEqual(['A楼 · 电气']); expect(result.path).toBe('/inventory-management');
  });
  it('permission editor initially locates the requested module and combines duplicate conditions', () => {
    const props = { value: { mode: 'independent', baseline: policy(), overrides: { rules: [], allowPages: [], denyPages: [] } }, principal: { role: 'guest', purchaseBuilding: null }, requestedPermissions: [{ kind: 'action', module: 'inventory', action: 'read', buildings: ['B楼'], specialties: null }] } as any;
    const tree = render(() => PermissionEditor(props));
    expect(nodes(tree).find(node => node.props['aria-label'] === '权限配置页面')!.props.value).toBe('/inventory-management');
    const conditions = nodes(tree).find(node => node.props['aria-label'] === '办理条件');
    expect(words(conditions)).toContain('单据阶段');
    expect(words(conditions).split('单据阶段')).toHaveLength(2);
  });
  it('copies custom roles into a new template without changing the source or followers', async () => {
    const props = { roles: { revision: 1, roles: [template()] }, accounts: [], revision: 1, loading: false, error: '', onRefresh: jest.fn(), onSaved: jest.fn() } as any;
    let tree = render(() => RolesPanel(props)); button(tree, '复制').props.onClick(); tree = render(() => RolesPanel(props));
    const child = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'RoleEditor')!;
    cleanup(); const show = () => render(() => (child.type as any)(child.props));
    expect(nodes(show()).find(node => node.props.id === 'authorization-role-name')!.props.value).toBe('合成角色（副本）');
    (previewAuthorizationRole as jest.Mock).mockResolvedValue({ revision: 1, affectedAccounts: [] }); button(show(), '核对影响').props.onClick(); await settle();
    const sent = (previewAuthorizationRole as jest.Mock).mock.calls[0][0]; expect(sent).not.toHaveProperty('id'); expect(sent.policy).toEqual(props.roles.roles[0].policy); expect(sent.policy).not.toBe(props.roles.roles[0].policy);
  });
  it('requires explicit conflict baseline adoption, preserving draft and clearing previous preview', async () => {
    const original = template(), parent = { roles: { revision: 1, roles: [original] }, accounts: [], revision: 1, loading: false, error: '', onRefresh: jest.fn(), onSaved: jest.fn() } as any;
    let tree = render(() => RolesPanel(parent)); button(tree, '编辑').props.onClick(); tree = render(() => RolesPanel(parent));
    const child = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'RoleEditor')!; let props = { ...child.props };
    cleanup(); const show = () => render(() => (child.type as any)(props));
    nodes(show()).find(node => node.props.id === 'authorization-role-description')!.props.onChange({ target: { value: '我的草稿' } });
    props = { ...props, revision: 2, directoryRevision: 2, current: { ...original, version: 2, description: '另一个管理员' } };
    tree = show(); expect(words(tree)).toContain('编辑开始时的基线'); expect(button(tree, '核对影响').props.disabled).toBe(true);
    expect(nodes(tree).find(node => node.props.id === 'authorization-role-description')!.props.value).toBe('我的草稿');
    button(tree, '保留草稿，按最新版本重新核对').props.onClick(); tree = show(); expect(button(tree, '核对影响').props.disabled).toBe(false); expect(button(tree, '保存角色').props.disabled).toBe(true);
    (previewAuthorizationRole as jest.Mock).mockResolvedValue({ revision: 2, affectedAccounts: [] }); button(tree, '核对影响').props.onClick(); await settle();
    expect((previewAuthorizationRole as jest.Mock).mock.calls[0][0]).toMatchObject({ expectedRevision: 2, description: '我的草稿' });
  });
  it('late request GET cannot undo a successful review and editor receives request context', async () => {
    const old = deferred<any[]>(), request = row(); (listPermissionRequests as jest.Mock).mockResolvedValueOnce([request]).mockReturnValueOnce(old.promise);
    const props = { revision: 1, onEditAccount: jest.fn().mockReturnValue(true), onPendingCount: jest.fn() }, show = () => render(() => PermissionRequestsPanel(props));
    show(); await settle(); let tree = show(); button(tree, '刷新申请').props.onClick(); tree = show();
    const list = nodes(tree).find(node => node.type === PermissionRequestList)!; expect(list.props.externallyFiltered).toBe(true);
    const actions = list.props.actions(request); button(actions, '配置权限').props.onClick(); expect(props.onEditAccount).toHaveBeenCalledWith(request.accountId, request);
    (reviewPermissionRequest as jest.Mock).mockResolvedValue({ ...request, version: 2, status: 'approved' }); button(actions, '确认授权').props.onClick(); await settle(); show();
    old.resolve([request]); await settle(); tree = show(); expect(nodes(tree).find(node => node.type === PermissionRequestList)!.props.requests).toEqual([]);
    expect(props.onPendingCount).toHaveBeenLastCalledWith(0);
  });
  it('same-version fresh read can refresh current effective-grant status, but not overwrite a newer record', () => {
    expect(mergeVersionedRows([{ id: 'a', version: 1, effect: 'none' }], [{ id: 'a', version: 1, effect: 'current' }])[0].effect).toBe('current');
    expect(mergeVersionedRows([{ id: 'a', version: 2, effect: 'current' }], [{ id: 'a', version: 1, effect: 'none' }])[0].version).toBe(2);
  });
  it('correction review requires a reason and explicit source verification; failed draft and mutation survive', async () => {
    const request = { ...row(), fields: ['phone'], description: '资料有误' } as any;
    (listAdminArchiveCorrections as jest.Mock).mockResolvedValue([request]); const show = () => render(() => ArchiveCorrectionsPanel({})); show(); await settle();
    let tree = show(); expect(button(tree, '确认已处理').props.disabled).toBe(true); button(tree, '驳回').props.onClick(); await settle(); expect(reviewArchiveCorrection).not.toHaveBeenCalled();
    nodes(show()).find(node => node.type === 'textarea')!.props.onChange({ target: { value: '已核对源资料' } }); nodes(show()).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
    (reviewArchiveCorrection as jest.Mock).mockRejectedValueOnce(new Error('结果未确认')).mockResolvedValueOnce({ ...request, status: 'resolved', version: 2 });
    button(show(), '确认已处理').props.onClick(); await settle(); tree = show(); expect(nodes(tree).find(node => node.type === 'textarea')!.props.value).toBe('已核对源资料');
    button(tree, '确认已处理').props.onClick(); await settle(); expect((reviewArchiveCorrection as jest.Mock).mock.calls[0][0]).toEqual((reviewArchiveCorrection as jest.Mock).mock.calls[1][0]);
  });
  it('audit includes records after 100 and filters by local date, actor and action', () => {
    const rows = Array.from({ length: 125 }, (_, i) => ({ id: String(i), at: i === 124 ? '2026-10-28T04:00:00Z' : '2026-10-29T04:00:00Z', actorId: i === 124 ? 'other' : 'admin', actorName: '合成', target: '目标', action: i === 124 ? '停用' : '保存', before: '', after: '' }));
    expect(filterConfigurationAudit(rows, '', '', '', '', '')).toHaveLength(125);
    expect(filterConfigurationAudit(rows, '', 'other', '停用', '2026-10-28', '2026-10-28').map(row => row.id)).toEqual(['124']);
  });
  it('exports display-only JSON fields without internal identities or configuration payload', () => {
    const request = { ...row(), applicantIdentity: 'secret-identity', reviewerAccountId: 'secret-reviewer', clientMutationId: 'secret-mutation', reason: 'ou_1234567890123456 110101199001010010', password: 'never-export' } as any;
    const exported = permissionRequestExport([request])[0], text = JSON.stringify(exported);
    for (const key of ['accountId', 'applicantIdentity', 'reviewerAccountId', 'clientMutationId', 'password', 'permissionsRevoked']) expect(exported).not.toHaveProperty(key);
    expect(text).not.toContain('110101199001010010'); expect(text).not.toContain('ou_1234567890123456'); expect(text).not.toContain('never-export');
    expect(archiveCorrectionExport([{ ...request, fields: ['phone'], description: '修改手机' }])[0]).not.toHaveProperty('accountId');
    expect(auditExportRows([{ ...request, at: 'now', actorName: '合成', action: '修改', target: '本人', before: 'never-export', after: 'never-export' } as any])[0]).toEqual({ time: 'now', operator: '合成', action: '修改', target: '本人' });
  });
  it('organizes every existing tab and correction review into four groups with one mobile selector', () => {
    expect(CONFIGURATION_GROUPS).toHaveLength(4); const names = CONFIGURATION_GROUPS.flatMap(group => group.tabs.map(tab => tab[0])); expect(new Set(names).size).toBe(13);
    const tree = ConfigurationNavigation({ tab: 'permission-requests', onChange: jest.fn(), permissionPending: 3, correctionPending: 2 });
    const selects = nodes(tree).filter(node => node.type === 'select'); expect(selects).toHaveLength(1); expect(selects[0].props.value).toBe('permission-requests'); expect(words(tree)).toContain('待处理 3');
  });
});
