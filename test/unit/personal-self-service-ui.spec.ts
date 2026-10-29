import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = [];
let mockCursor = 0;
const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useCallback: (callback: unknown) => callback,
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
import { addRequestedPermission } from '../../client/src/pages/PersonalCenter/permission-request.logic';

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
  it('admin opens existing editor and preserves pending review/comment on failed effective-grant verification', async () => {
    (listPermissionRequests as jest.Mock).mockResolvedValue([row]);
    const props = { revision: 1, onEditAccount: jest.fn().mockReturnValue(true) }, show = () => render(() => PermissionRequestsPanel(props));
    show(); await flush(); const list = () => nodes(show()).find(node => node.type === PermissionRequestList)!;
    let actions = list().props.actions(row); button(actions, '配置权限').props.onClick(); expect(props.onEditAccount).toHaveBeenCalledWith('synthetic-person'); expect(reviewPermissionRequest).not.toHaveBeenCalled();
    nodes(actions).find(node => node.type === 'textarea')!.props.onChange(event('审核说明'));
    (reviewPermissionRequest as jest.Mock).mockRejectedValueOnce(new Error('申请权限尚未生效')).mockResolvedValueOnce({ ...row, version: 2, status: 'approved' });
    actions = list().props.actions(row); button(actions, '确认授权').props.onClick(); await flush(); expect(words(show())).toContain('申请权限尚未生效');
    actions = list().props.actions(row); expect(nodes(actions).find(node => node.type === 'textarea')!.props.value).toBe('审核说明');
    button(actions, '确认授权').props.onClick(); await flush(); expect((reviewPermissionRequest as jest.Mock).mock.calls[0][0]).toEqual((reviewPermissionRequest as jest.Mock).mock.calls[1][0]);
  });
});
