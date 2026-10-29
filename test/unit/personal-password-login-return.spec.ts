import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = [];
let mockCursor = 0;
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useMemo: (factory: () => unknown) => factory(), useCallback: (callback: unknown) => callback, useEffect: () => undefined,
}));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/personal-center', search: '', hash: '', key: 'synthetic' }), useNavigate: () => jest.fn() }));
jest.mock('../../client/src/api', () => ({ getAccessSession: jest.fn(), loginAccess: jest.fn(), logoutAccess: jest.fn() }));
jest.mock('../../client/src/access/use-feishu-login', () => ({ useFeishuLogin: () => ({ start: jest.fn(), isPending: false, error: null }) }));
jest.mock('../../client/src/components/FeishuIcon', () => ({ FeishuIcon: 'i' }));
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), dismiss: jest.fn() } }));
import { isValidElement } from 'react';
import { AccessProvider } from '../../client/src/access/AccessProvider';
import { Tabs } from '../../client/src/components/ui/tabs';

function nodes(node: ReactNode): ReactElement<any>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : []; }
function words(node: ReactNode): string { return typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(words).join('') : isValidElement<any>(node) ? words(node.props.children) : ''; }
function render(): ReactElement<any> { mockCursor = 0; return AccessProvider({ children: 'synthetic business' }); }
const login = (tree: ReactElement<any>) => nodes(tree).find(node => typeof node.props.onPasswordReset === 'function')!;

describe('password completion keeps its explicit login state', () => {
  beforeEach(() => { mockSlots.length = 0; mockCursor = 0; jest.clearAllMocks(); });
  it('coalesces a queued automatic gate without replacing the name-login tab or completion notice', () => {
    const context = render().props.value;
    context.passwordChanged();
    // This timer was scheduled by the previous unauthenticated route render.
    context.requestLogin('当前页面不对游客开放，请登录后访问。', '/personal-center', undefined, undefined, true);
    let tree = render(), dialog = login(tree);
    expect(dialog.props.open).toBe(true); expect(dialog.props.initialMethod).toBe('employee');
    expect(dialog.props.notice).toBe('密码已更新，请使用新密码重新登录。');
    expect(tree.props.value.isLoginDialogOpen).toBe(true);
    const requestKey = dialog.props.resetKey;
    tree.props.value.requestLogin('另一个自动登录请求', '/personal-center', undefined, undefined, true);
    tree = render(); dialog = login(tree); expect(dialog.props.resetKey).toBe(requestKey);
    expect(dialog.props.reason).toBe('密码已更新，请重新登录。');
    // Render the actual private login dialog with its accepted props.
    mockSlots.length = 0; mockCursor = 0;
    const content = (dialog.type as (props: unknown) => ReactNode)(dialog.props);
    expect(nodes(content).find(node => node.type === Tabs)?.props.value).toBe('employee');
    expect(nodes(content).find(node => node.props.role === 'status' && words(node).includes('密码已更新'))).toBeDefined();
  });
  it('still allows explicit account switching and preserves the normal Feishu entry', () => {
    render().props.value.passwordChanged();
    render().props.value.requestLogin('请选择登录方式。', '/monthly-schedule');
    const dialog = login(render());
    expect(dialog.props.initialMethod).toBeUndefined(); expect(dialog.props.notice).toBeUndefined();
    expect(dialog.props.reason).toBe('请选择登录方式。');
  });
});
