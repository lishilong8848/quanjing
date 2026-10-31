import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = [];
let mockCursor = 0;
const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => any, dependencies: unknown[]) => { const slot = mockCursor++, previous = mockSlots[slot]; if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) { const next = { dependencies, cleanup: previous?.cleanup }; mockSlots[slot] = next; mockEffects.push(() => { next.cleanup?.(); next.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/api/personal-access', () => ({ changePersonalPassword: jest.fn(), resetPersonalPassword: jest.fn(), createPermissionRequest: jest.fn(), listPermissionRequests: jest.fn(), reviewPermissionRequest: jest.fn() }));

import { isValidElement } from 'react';
import { changePersonalPassword, resetPersonalPassword, createPermissionRequest, listPermissionRequests, reviewPermissionRequest } from '../../client/src/api/personal-access';
import { PasswordChangeDialog } from '../../client/src/access/PasswordChangeDialog';
import { ForgotPasswordDialog } from '../../client/src/access/ForgotPasswordDialog';
import { PermissionRequestForm } from '../../client/src/pages/PersonalCenter/PermissionRequestForm';
import { PermissionRequestsPanel } from '../../client/src/pages/SystemConfiguration/PermissionRequestsPanel';
import { PermissionRequestList } from '../../client/src/pages/PersonalCenter/PermissionRequestList';
import { Input } from '../../client/src/components/ui/input';
import { Dialog, DialogContent } from '../../client/src/components/ui/dialog';
import { createPermissionCatalog } from '../../shared/permission-catalog';
import { createPersonalMutationIdentity, validateNewPersonalPassword, validatePasswordResetIdentity } from '../../client/src/access/personal-password.logic';
import { addRequestedPermission, requestablePermissionPages } from '../../client/src/pages/PersonalCenter/permission-request.logic';

function nodes(node: ReactNode): ReactElement<any>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : []; }
function words(node: ReactNode): string { return typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : ''; }
function render<T>(factory: () => T): T { mockCursor = 0; const tree = factory(); mockEffects.splice(0).forEach(effect => effect()); return tree; }
const button = (tree: ReactNode, text: string) => nodes(tree).find(node => typeof node.props.onClick === 'function' && words(node.props.children) === text)!;
const inputs = (tree: ReactNode) => nodes(tree).filter(node => node.type === Input);
const submit = (tree: ReactNode) => nodes(tree).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const event = (value: string) => ({ target: { value } });
function cleanup() { mockSlots.forEach(slot => { if (slot?.cleanup) slot.cleanup(); }); mockSlots.length = 0; mockEffects.length = 0; mockCursor = 0; }
const row = { id: 'synthetic-request', version: 1, accountId: 'synthetic-person', applicantName: '合成人员', permissions: [{ kind: 'page' as const, path: '/nantong-base' }], reason: '合成工作需要', status: 'pending' as const, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z' };

describe('personal self-service real callbacks and safe retries', () => {
  beforeEach(() => { cleanup(); jest.clearAllMocks(); });
  afterEach(cleanup);
  it('does not trim formal passwords and counts Unicode characters', () => {
    expect(validateNewPersonalPassword(' 12345678 ', ' 12345678 ')).toBeNull();
    expect(validateNewPersonalPassword('12345678 ', '12345678')).toContain('不一致');
    expect(validateNewPersonalPassword('😀'.repeat(128), '😀'.repeat(128))).toBeNull();
    expect(validateNewPersonalPassword('1'.repeat(129), '1'.repeat(129))).toContain('128');
    expect(validatePasswordResetIdentity('合成人员', '123456')).toContain('完整');
  });
  it('retains mutation ids for unchanged retries and clears in-memory payload on leave', () => {
    const id = jest.fn().mockReturnValueOnce('first').mockReturnValueOnce('second').mockReturnValueOnce('third');
    const mutation = createPersonalMutationIdentity(id);
    expect(mutation.forPayload({ password: ' raw ' })).toBe('first');
    expect(mutation.forPayload({ password: ' raw ' })).toBe('first');
    expect(mutation.forPayload({ password: 'raw' })).toBe('second');
    mutation.clear(); expect(mutation.forPayload({ password: 'raw' })).toBe('third');
  });
  it('forces first password change, prevents closing, retains failed fields/id and submits only once at a time', async () => {
    const props = { open: true, required: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn() };
    const show = () => render(() => PasswordChangeDialog(props));
    let tree = show(); const content = nodes(tree).find(node => node.type === DialogContent)!;
    expect(content.props.showCloseButton).toBe(false); const escape = { preventDefault: jest.fn() }; content.props.onEscapeKeyDown(escape); expect(escape.preventDefault).toHaveBeenCalled();
    nodes(tree).find(node => node.type === Dialog)!.props.onOpenChange(false); expect(props.onClose).not.toHaveBeenCalled();
    inputs(tree)[0].props.onChange(event('123456')); inputs(tree)[1].props.onChange(event('  raw-password  ')); inputs(tree)[2].props.onChange(event('  raw-password  '));
    (changePersonalPassword as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('结果未确认'), { uncertain: true })).mockResolvedValueOnce(undefined);
    tree = show(); submit(tree); submit(tree); await flush(); expect(changePersonalPassword).toHaveBeenCalledTimes(1);
    tree = show(); expect(inputs(tree)[1].props.value).toBe('  raw-password  '); expect(words(tree)).toContain('结果未确认');
    submit(tree); await flush(); expect(changePersonalPassword).toHaveBeenCalledTimes(2);
    expect((changePersonalPassword as jest.Mock).mock.calls[0][0]).toEqual((changePersonalPassword as jest.Mock).mock.calls[1][0]);
    expect(props.onSuccess).toHaveBeenCalledTimes(1); expect(inputs(show()).every(input => input.props.value === '')).toBe(true);
  });
  it('locks an uncertain attempt and retries its original payload even if an input event arrives', async () => {
    const props = { open: true, required: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn() };
    const show = () => render(() => PasswordChangeDialog(props));
    let tree = show(); inputs(tree)[0].props.onChange(event('current-password'));
    inputs(tree)[1].props.onChange(event('first-new-password')); inputs(tree)[2].props.onChange(event('first-new-password'));
    (changePersonalPassword as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('结果未确认'), { uncertain: true, passwordRecovery: 'retry' })).mockResolvedValueOnce(undefined);
    submit(show()); await flush(); tree = show();
    expect(inputs(tree).every(input => input.props.disabled === true)).toBe(true);
    expect(words(tree)).toContain('核对并重试');
    inputs(tree)[1].props.onChange(event('changed-after-timeout'));
    inputs(tree)[2].props.onChange(event('changed-after-timeout'));
    submit(show()); await flush();
    expect((changePersonalPassword as jest.Mock).mock.calls[1][0]).toEqual((changePersonalPassword as jest.Mock).mock.calls[0][0]);
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit refill after uncertainty and gives that new attempt a new id', async () => {
    const props = { open: true, required: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn() };
    const show = () => render(() => PasswordChangeDialog(props));
    let tree = show(); inputs(tree)[0].props.onChange(event('current-password'));
    inputs(tree)[1].props.onChange(event('first-new-password')); inputs(tree)[2].props.onChange(event('first-new-password'));
    let reject!: (error: Error) => void;
    (changePersonalPassword as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; })).mockResolvedValueOnce(undefined);
    submit(show()); tree = show();
    expect(button(tree, '重新填写')).toBeUndefined();
    reject(Object.assign(new Error('结果未确认'), { uncertain: true, passwordRecovery: 'retry' })); await flush();
    button(show(), '重新填写').props.onClick(); tree = show();
    expect(inputs(tree).every(input => !input.props.disabled)).toBe(true);
    inputs(tree)[0].props.onChange(event('current-password'));
    inputs(tree)[1].props.onChange(event('second-new-password')); inputs(tree)[2].props.onChange(event('second-new-password'));
    submit(show()); await flush();
    const first = (changePersonalPassword as jest.Mock).mock.calls[0][0], second = (changePersonalPassword as jest.Mock).mock.calls[1][0];
    expect(second.clientMutationId).not.toBe(first.clientMutationId);
    expect(second.newPassword).toBe('second-new-password'); expect(props.onSuccess).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('returns to login without repeating a known-updated or expired-session attempt (uncertain=%s)', async uncertain => {
    const props = { open: true, required: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn().mockResolvedValue(undefined) };
    const show = () => render(() => PasswordChangeDialog(props));
    let tree = show(); inputs(tree)[0].props.onChange(event('current-password'));
    inputs(tree)[1].props.onChange(event('new-password')); inputs(tree)[2].props.onChange(event('new-password'));
    (changePersonalPassword as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('请使用上次设置的新密码重新登录'), { uncertain, passwordRecovery: 'login', status: uncertain ? 401 : 409 }));
    submit(show()); await flush(); tree = show();
    expect(words(tree)).not.toContain('核对并重试'); expect(words(tree)).not.toContain('保存新密码');
    submit(tree); await flush(); expect(changePersonalPassword).toHaveBeenCalledTimes(1);
    button(tree, '返回登录').props.onClick(); await flush(); expect(props.onLogout).toHaveBeenCalledTimes(1);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });
  it('releases a definitive conflict id before the user submits the same fields again', async () => {
    const props = { open: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn() };
    const show = () => render(() => PasswordChangeDialog(props));
    let tree = show(); inputs(tree)[0].props.onChange(event('current-password'));
    inputs(tree)[1].props.onChange(event('new-password')); inputs(tree)[2].props.onChange(event('new-password'));
    (changePersonalPassword as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('密码来源已变化，请核对后重新提交'), { uncertain: false, status: 409 })).mockResolvedValueOnce(undefined);
    submit(show()); await flush(); submit(show()); await flush();
    expect((changePersonalPassword as jest.Mock).mock.calls[1][0].clientMutationId).not.toBe((changePersonalPassword as jest.Mock).mock.calls[0][0].clientMutationId);
  });
  it('clears an unmounted account attempt and ignores its late result without using browser storage', async () => {
    const storageDescriptors = ['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key] of storageDescriptors) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('Password drafts must never use storage'); } });
    try {
      const first = { open: true, required: true, onClose: jest.fn(), onSuccess: jest.fn(), onLogout: jest.fn() };
      let show = () => render(() => PasswordChangeDialog(first));
      let tree = show(); inputs(tree)[0].props.onChange(event('first-current'));
      inputs(tree)[1].props.onChange(event('first-new-password')); inputs(tree)[2].props.onChange(event('first-new-password'));
      let finish!: () => void;
      (changePersonalPassword as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValueOnce(undefined);
      submit(show()); const originalId = (changePersonalPassword as jest.Mock).mock.calls[0][0].clientMutationId;
      cleanup();
      const second = { ...first, onSuccess: jest.fn() };
      show = () => render(() => PasswordChangeDialog(second)); tree = show();
      expect(inputs(tree).every(input => input.props.value === '')).toBe(true);
      inputs(tree)[0].props.onChange(event('second-current'));
      inputs(tree)[1].props.onChange(event('second-new-password')); inputs(tree)[2].props.onChange(event('second-new-password'));
      submit(show()); await flush(); finish(); await flush();
      expect(first.onSuccess).not.toHaveBeenCalled(); expect(second.onSuccess).toHaveBeenCalledTimes(1);
      expect((changePersonalPassword as jest.Mock).mock.calls[1][0].clientMutationId).not.toBe(originalId);
      expect(inputs(show()).every(input => input.props.value === '')).toBe(true);
    } finally {
      for (const [key, descriptor] of storageDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  it('performs no identity pre-check before final reset, and does not send a partial ID', async () => {
    const props = { open: true, initialName: '合成人员', onClose: jest.fn(), onSuccess: jest.fn() };
    const show = () => render(() => ForgotPasswordDialog(props));
    let tree = show(); inputs(tree)[1].props.onChange(event('123456')); inputs(tree)[2].props.onChange(event('  new-password  ')); inputs(tree)[3].props.onChange(event('  new-password  '));
    expect(resetPersonalPassword).not.toHaveBeenCalled(); submit(show()); await flush(); expect(resetPersonalPassword).not.toHaveBeenCalled();
    inputs(show())[1].props.onChange(event('110101199001010010')); (resetPersonalPassword as jest.Mock).mockRejectedValueOnce(new Error('核验失败')).mockResolvedValueOnce(undefined);
    submit(show()); await flush(); tree = show(); expect(inputs(tree)[1].props.value).toBe('110101199001010010');
    submit(tree); await flush(); expect((resetPersonalPassword as jest.Mock).mock.calls[0][0]).toEqual((resetPersonalPassword as jest.Mock).mock.calls[1][0]);
    expect(props.onSuccess).toHaveBeenCalledTimes(1); expect(inputs(show()).slice(1).every(input => input.props.value === '')).toBe(true);
  });
  it('clears sensitive fields when closed', () => {
    let open = true; const show = () => render(() => ForgotPasswordDialog({ open, initialName: '合成', onClose() {}, onSuccess() {} }));
    inputs(show())[1].props.onChange(event('110101199001010010')); open = false; show(); expect(inputs(show())[1].props.value).toBe('');
  });
  it('keeps a failed permission application and mutation id, and does not claim success before acceptance', async () => {
    const props = { catalog: createPermissionCatalog(), onSubmitted: jest.fn() };
    const show = () => render(() => PermissionRequestForm(props));
    let tree = show(); button(tree, '添加申请项').props.onClick(); nodes(show()).find(node => node.type === 'textarea')!.props.onChange(event('合成工作需要'));
    (createPermissionRequest as jest.Mock).mockRejectedValueOnce(new Error('暂时失败')).mockResolvedValueOnce(row);
    submit(show()); await flush(); tree = show(); expect(words(tree)).toContain('暂时失败'); expect(nodes(tree).find(node => node.type === 'textarea')!.props.value).toBe('合成工作需要'); expect(props.onSubmitted).not.toHaveBeenCalled();
    submit(tree); await flush(); expect((createPermissionRequest as jest.Mock).mock.calls[0][0]).toEqual((createPermissionRequest as jest.Mock).mock.calls[1][0]); expect(props.onSubmitted).toHaveBeenCalledWith(row);
    expect(words(show())).toContain('申请已提交');
  });
  it('deduplicates requested grants and enforces the 20-item cap', () => {
    const current = [{ kind: 'page' as const, path: '/nantong-base' }]; expect(addRequestedPermission(current, current[0])).toBe(current);
    expect(() => addRequestedPermission(Array.from({ length: 20 }, (_, i) => ({ kind: 'page', path: `/synthetic/${i}` })), current[0])).toThrow('20');
  });
  it('admin keeps the optional editor and preserves confirmed scope/comment/id after a grant conflict', async () => {
    (listPermissionRequests as jest.Mock).mockResolvedValue([row]);
    const props = { revision: 1, onEditAccount: jest.fn().mockReturnValue(true), onGranted: jest.fn() }, show = () => render(() => PermissionRequestsPanel(props));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    let actions = list().props.actions(row); button(actions, '配置权限').props.onClick(); expect(props.onEditAccount).toHaveBeenCalledWith('synthetic-person', row); expect(reviewPermissionRequest).not.toHaveBeenCalled();
    nodes(actions).find(node => node.type === 'textarea')!.props.onChange(event('审核说明'));
    expect(button(actions, '同意并授权').props.disabled).toBe(true);
    button(actions, '同意并授权').props.onClick(); await flush(); expect(reviewPermissionRequest).not.toHaveBeenCalled();
    nodes(actions).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
    (reviewPermissionRequest as jest.Mock).mockRejectedValueOnce(new Error('申请权限与现有禁止规则冲突')).mockResolvedValueOnce({ ...row, version: 2, status: 'approved' });
    actions = list().props.actions(row); button(actions, '同意并授权').props.onClick(); await flush(); expect(words(show())).toContain('申请权限与现有禁止规则冲突');
    actions = list().props.actions(row); expect(nodes(actions).find(node => node.type === 'textarea')!.props.value).toBe('审核说明');
    expect(nodes(actions).find(node => node.type === 'input')!.props.checked).toBe(true);
    button(actions, '同意并授权').props.onClick(); await flush(); expect((reviewPermissionRequest as jest.Mock).mock.calls[0][0]).toEqual((reviewPermissionRequest as jest.Mock).mock.calls[1][0]);
    expect(props.onGranted).toHaveBeenCalledTimes(1);
  });
  it('offers the complete configurable request catalog independent of current grants and searches actual operations', () => {
    const catalog = createPermissionCatalog();
    const props = { catalog, principal: { role: 'guest' as const, building: null, pagePaths: ['/nantong-base'] }, onSubmitted: jest.fn() };
    const show = () => render(() => PermissionRequestForm(props));
    let tree = show();
    expect(words(tree)).toContain('全部可申请权限'); expect(words(tree)).toContain('不受当前角色限制');
    const pages = () => nodes(show()).find(node => node.type === 'select')!;
    expect(nodes(pages()).filter(node => node.type === 'option')).toHaveLength(requestablePermissionPages(catalog).length);
    const search = nodes(tree).find(node => node.type === 'input' && node.props.placeholder?.includes('搜索页面、功能'))!;
    search.props.onChange(event('出入库')); tree = show();
    expect(pages().props.value).toBe('/inventory-management');
    expect(nodes(pages()).filter(node => node.type === 'option').map(node => node.props.value)).toEqual(['/inventory-management']);
    search.props.onChange(event('不存在的合成功能')); expect(words(show())).toContain('没有匹配的页面或功能');
  });
  it('excludes fixed administrator and arbitrary URLs while preserving registered external entries', () => {
    const catalog = createPermissionCatalog();
    const injected = { ...catalog, pages: [...catalog.pages, { ...catalog.pages[0], path: '/system-configuration', kind: 'business' }, { ...catalog.pages[0], path: 'https://example.invalid', kind: 'external' }] } as any;
    const paths = requestablePermissionPages(injected).map(page => page.path);
    expect(paths).not.toContain('/system-configuration'); expect(paths).not.toContain('https://example.invalid');
    const external = catalog.pages.find(page => page.kind === 'external')!;
    expect(external).toBeDefined(); expect(paths).toContain(external.path);
    const exportPage = catalog.pages.find(page => page.modules.some(module => module.actions.some(action => action === 'export')))!;
    expect(exportPage).toBeDefined();
    expect(requestablePermissionPages(catalog, '导出').some(page => page.path === exportPage.path)).toBe(true);
  });
  it('requests a registered external entry without permitting external actions, even after an action selection', async () => {
    const catalog = createPermissionCatalog(), external = catalog.pages.find(page => page.kind === 'external')!;
    const show = () => render(() => PermissionRequestForm({ catalog, onSubmitted: jest.fn() }));
    let tree = show(); const selects = () => nodes(show()).filter(node => node.type === 'select');
    selects()[1].props.onChange(event('action'));
    selects()[0].props.onChange(event(external.path)); tree = show();
    expect(selects()[1].props.value).toBe('page');
    expect(nodes(selects()[1]).find(node => node.type === 'option' && node.props.value === 'action')!.props.disabled).toBe(true);
    expect(words(tree)).toContain('仅申请该外链在本平台的入口，不改变外部系统内部权限');
    button(tree, '添加申请项').props.onClick();
    nodes(show()).find(node => node.type === 'textarea')!.props.onChange(event('需要平台入口'));
    (createPermissionRequest as jest.Mock).mockResolvedValue(row);
    submit(show()); await flush();
    expect((createPermissionRequest as jest.Mock).mock.calls[0][0].permissions).toEqual([{ kind: 'page', path: external.path }]);
  });
  it('reports a recovered approved request truthfully instead of saying it is still awaiting approval', async () => {
    const props = { catalog: createPermissionCatalog(), onSubmitted: jest.fn() };
    const show = () => render(() => PermissionRequestForm(props));
    button(show(), '添加申请项').props.onClick();
    nodes(show()).find(node => node.type === 'textarea')!.props.onChange(event('合成工作需要'));
    (createPermissionRequest as jest.Mock).mockResolvedValue({ ...row, status: 'approved' });
    submit(show()); await flush();
    expect(words(show())).toContain('此申请已授权'); expect(words(show())).not.toContain('等待管理员审核');
  });
  it('ties scope confirmation to the displayed request version', async () => {
    (listPermissionRequests as jest.Mock).mockResolvedValue([row]);
    const show = () => render(() => PermissionRequestsPanel({ revision: 1, onEditAccount: jest.fn() }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    const actions = list().props.actions(row);
    nodes(actions).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } });
    const next = list().props.actions({ ...row, version: 2 });
    expect(button(next, '同意并授权').props.disabled).toBe(true);
    button(next, '同意并授权').props.onClick(); await flush(); expect(reviewPermissionRequest).not.toHaveBeenCalled();
  });
  it.each(['pending', 'approved'])('opens a card-targeted %s request without status/search hiding it', async status => {
    const target = { ...row, id: '1b732251-0af2-4916-9e3d-3de527f15ef9', status }, other = { ...row, id: 'other-request' };
    (listPermissionRequests as jest.Mock).mockResolvedValue([other, target]);
    const show = () => render(() => PermissionRequestsPanel({ revision: 1, focusRequestId: target.id, focusNavigationKey: 'first-link', onEditAccount: jest.fn() }));
    show(); await flush(); let tree = show();
    expect(nodes(tree).find(node => node.type === PermissionRequestList)!.props.requests.map((item: any) => item.id)).toEqual([target.id]);
    expect(words(tree)).toContain('正在查看卡片中的申请');
    button(tree, '查看全部申请').props.onClick(); tree = show();
    expect(nodes(tree).find(node => node.type === PermissionRequestList)!.props.requests).toHaveLength(2);
  });
  it.each([['rejected', 0], ['approved', 1]])('shows returned %s truthfully after a rejection click', async (status, grants) => {
    (listPermissionRequests as jest.Mock).mockResolvedValue([row]);
    (reviewPermissionRequest as jest.Mock).mockResolvedValue({ ...row, version: 2, status });
    const onGranted = jest.fn(), show = () => render(() => PermissionRequestsPanel({ revision: 1, onEditAccount: jest.fn(), onGranted }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    let actions = list().props.actions(row); nodes(actions).find(node => node.type === 'textarea')!.props.onChange(event('核对处理结果'));
    actions = list().props.actions(row); button(actions, '驳回').props.onClick(); await flush();
    expect((reviewPermissionRequest as jest.Mock).mock.calls[0][0].decision).toBe('reject');
    expect(onGranted).toHaveBeenCalledTimes(Number(grants));
    expect(words(show())).toContain(status === 'approved' ? '申请已授权' : '申请已驳回');
    if (status === 'approved') expect(words(show())).not.toContain('申请已驳回');
  });
  it.each(['success', 'error'])('clears the previous card target %s feedback on navigation without dropping unrelated drafts', async outcome => {
    const other = { ...row, id: 'other-request' };
    (listPermissionRequests as jest.Mock).mockResolvedValue([row, other]);
    let focusRequestId = row.id, focusNavigationKey = 'card-a';
    const show = () => render(() => PermissionRequestsPanel({ revision: 1, focusRequestId, focusNavigationKey, onEditAccount: jest.fn() }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    nodes(list().props.actions(other)).find(node => node.type === 'textarea')!.props.onChange(event('其他申请的草稿'));
    nodes(list().props.actions(row)).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } });
    if (outcome === 'success') (reviewPermissionRequest as jest.Mock).mockResolvedValue({ ...row, version: 2, status: 'approved' });
    else (reviewPermissionRequest as jest.Mock).mockRejectedValue(new Error('合成旧申请错误'));
    button(list().props.actions(row), '同意并授权').props.onClick(); await flush();
    expect(words(show())).toContain(outcome === 'success' ? '申请已授权' : '合成旧申请错误');
    focusRequestId = other.id; focusNavigationKey = 'card-b'; show(); await flush();
    expect(words(show())).not.toContain('申请已授权'); expect(words(show())).not.toContain('合成旧申请错误');
    expect(nodes(list().props.actions(other)).find(node => node.type === 'textarea')!.props.value).toBe('其他申请的草稿');
  });
  it('merges a late approval and refreshes configuration without showing its success on the newly opened card', async () => {
    const other = { ...row, id: 'other-request' };
    (listPermissionRequests as jest.Mock).mockResolvedValue([row, other]);
    let focusRequestId = row.id, focusNavigationKey = 'card-a', finish!: (value: unknown) => void;
    const onGranted = jest.fn(), show = () => render(() => PermissionRequestsPanel({ revision: 1, focusRequestId, focusNavigationKey, onEditAccount: jest.fn(), onGranted }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    nodes(list().props.actions(row)).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } });
    (reviewPermissionRequest as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    button(list().props.actions(row), '同意并授权').props.onClick();
    focusRequestId = other.id; focusNavigationKey = 'card-b'; show(); await flush();
    finish({ ...row, version: 2, status: 'approved' }); await flush();
    expect(onGranted).toHaveBeenCalledTimes(1); expect(words(show())).not.toContain('申请已授权');
    expect(list().props.requests.map((item: any) => item.id)).toEqual([other.id]);
    button(show(), '查看全部申请').props.onClick();
    expect(list().props.requests.find((item: any) => item.id === row.id).status).toBe('approved');
  });
  it('suppresses a late failure on another card but retains the original review payload and id for its retry', async () => {
    const other = { ...row, id: 'other-request' };
    (listPermissionRequests as jest.Mock).mockResolvedValue([row, other]);
    let focusRequestId = row.id, focusNavigationKey = 'card-a', reject!: (value: unknown) => void;
    const show = () => render(() => PermissionRequestsPanel({ revision: 1, focusRequestId, focusNavigationKey, onEditAccount: jest.fn() }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    nodes(list().props.actions(row)).find(node => node.type === 'textarea')!.props.onChange(event('原审批意见'));
    nodes(list().props.actions(row)).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } });
    (reviewPermissionRequest as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({ ...row, version: 2, status: 'approved' });
    button(list().props.actions(row), '同意并授权').props.onClick();
    focusRequestId = other.id; focusNavigationKey = 'card-b'; show(); await flush();
    reject(new Error('合成迟到错误')); await flush(); expect(words(show())).not.toContain('合成迟到错误');
    focusRequestId = row.id; focusNavigationKey = 'card-a-return'; show(); await flush();
    const actions = list().props.actions(row);
    expect(nodes(actions).find(node => node.type === 'textarea')!.props.value).toBe('原审批意见');
    expect(nodes(actions).find(node => node.type === 'input')!.props.checked).toBe(true);
    button(actions, '同意并授权').props.onClick(); await flush();
    expect((reviewPermissionRequest as jest.Mock).mock.calls[1][0]).toEqual((reviewPermissionRequest as jest.Mock).mock.calls[0][0]);
  });
  it('does not show a late configuration-refresh failure on another card after the approval succeeded', async () => {
    const other = { ...row, id: 'other-request' };
    (listPermissionRequests as jest.Mock).mockResolvedValue([row, other]);
    let focusRequestId = row.id, focusNavigationKey = 'card-a', failRefresh!: (value: unknown) => void;
    const onGranted = jest.fn(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
    const show = () => render(() => PermissionRequestsPanel({ revision: 1, focusRequestId, focusNavigationKey, onEditAccount: jest.fn(), onGranted }));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    nodes(list().props.actions(row)).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } });
    (reviewPermissionRequest as jest.Mock).mockResolvedValue({ ...row, version: 2, status: 'approved' });
    button(list().props.actions(row), '同意并授权').props.onClick(); await flush();
    expect(words(show())).toContain('申请已授权');
    focusRequestId = other.id; focusNavigationKey = 'card-b'; show(); await flush();
    failRefresh(new Error('合成配置读取失败')); await flush();
    expect(words(show())).not.toContain('申请已授权'); expect(words(show())).not.toContain('最新配置读取失败');
    expect(onGranted).toHaveBeenCalledTimes(1);
  });
});
