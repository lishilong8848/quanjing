import type { ReactElement, ReactNode } from 'react';
import type { AccessConfigurationResponse, ManagedAccount } from '../../shared/access-configuration.interface';

// This checks the real page's state/callback boundary, not browser paint latency.
const mockSlots: { value: unknown; dependencies?: unknown[] }[] = [];
let mockCursor = 0;
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = mockCursor++;
      if (!mockSlots[slot]) mockSlots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      return [mockSlots[slot].value, (next: unknown) => {
        mockSlots[slot].value = typeof next === 'function' ? next(mockSlots[slot].value) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const slot = mockCursor++;
      if (!mockSlots[slot]) mockSlots[slot] = { value: { current: initial } };
      return mockSlots[slot].value;
    },
    useMemo: (factory: () => unknown, dependencies: unknown[]) => {
      const slot = mockCursor++;
      const previous = mockSlots[slot];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies?.[index]))) {
        mockSlots[slot] = { value: factory(), dependencies };
      }
      return mockSlots[slot].value;
    },
    useCallback: (callback: unknown, dependencies: unknown[]) => {
      const slot = mockCursor++;
      const previous = mockSlots[slot];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies?.[index]))) {
        mockSlots[slot] = { value: callback, dependencies };
      }
      return mockSlots[slot].value;
    },
    useEffect: () => {},
  };
});
const mockCommit = jest.fn(), mockRefreshSession = jest.fn();
const mockAccount: ManagedAccount = { id: 'synthetic-account', kind: 'feishu', name: '合成人员', role: 'editor', building: null, enabled: true, deleted: false, source: 'configuration', version: 1 };
const mockData: AccessConfigurationResponse = { revision: 1, appId: 'synthetic-app', accounts: [mockAccount], cardRules: [], audit: [] };
const mockConfiguration = { data: mockData, people: [], loading: false, peopleLoading: false, error: '', peopleError: '', refresh: jest.fn(), refreshPeople: jest.fn(), commit: mockCommit };
let mockAccountId = 'other-account';
let mockLocation = { search: '', key: 'synthetic-navigation' };
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useLocation: () => mockLocation }));
jest.mock('../../client/src/pages/SystemConfiguration/model', () => ({
  ...jest.requireActual('../../client/src/pages/SystemConfiguration/model'),
  useConfiguration: () => mockConfiguration,
}));
jest.mock('../../client/src/access/AccessProvider', () => ({ useAccess: () => ({ accountId: mockAccountId, displayName: '合成管理员', refreshSession: mockRefreshSession }) }));
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }));
jest.mock('../../client/src/pages/SystemConfiguration/configuration.css', () => ({}));
jest.mock('../../client/src/pages/SystemConfiguration/permission-matrix.css', () => ({}));
jest.mock('../../client/src/assets/feishu-logo.svg', () => 'fixture-static-feishu-logo');
jest.mock('sonner', () => ({ toast: { success: jest.fn() } }));

import { isValidElement } from 'react';
import SystemConfigurationPage from '../../client/src/pages/SystemConfiguration';
import { AccountPanel } from '../../client/src/pages/SystemConfiguration/AccountPanel';
import { AccountEditor } from '../../client/src/pages/SystemConfiguration/AccountEditor';
import { CardPanel } from '../../client/src/pages/SystemConfiguration/CardPanel';
import { PermissionRequestsPanel } from '../../client/src/pages/SystemConfiguration/PermissionRequestsPanel';
import { permissionRequestLocation } from '../../client/src/pages/SystemConfiguration/permission-request-navigation';

function find(node: ReactNode, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
  if (!isValidElement<Record<string, any>>(node)) return undefined;
  return node.type === type ? node : find(node.props.children, type);
}
function renderPage() { mockCursor = 0; return SystemConfigurationPage(); }
function sameProps(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.is(a[key], b[key]));
}

describe('configuration editor render isolation', () => {
  beforeEach(() => { mockSlots.length = 0; mockCursor = 0; mockAccountId = 'other-account'; mockLocation = { search: '', key: 'synthetic-navigation' }; mockConfiguration.data = mockData; jest.clearAllMocks(); });
  it('memoizes the actual account and card panels using the default shallow boundary', () => {
    for (const panel of [AccountPanel, CardPanel]) {
      expect((panel as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect((panel as any).compare).toBeNull();
    }
  });
  it('keeps every account-panel prop stable during open and close', () => {
    const before = find(renderPage(), AccountPanel)!;
    before.props.onEdit(mockAccount);
    const opened = renderPage();
    expect(find(opened, AccountEditor)!.props.account).toBe(mockAccount);
    expect(sameProps(before.props, find(opened, AccountPanel)!.props)).toBe(true);
    find(opened, AccountEditor)!.props.onClose();
    const closed = renderPage();
    expect(find(closed, AccountEditor)).toBeUndefined();
    expect(sameProps(before.props, find(closed, AccountPanel)!.props)).toBe(true);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockConfiguration.refresh).not.toHaveBeenCalled();
  });
  it('keeps cached card-panel props stable while the account editor closes', () => {
    const initial = renderPage();
    const tabs = (initial.props.children as ReactNode[]).find(node => isValidElement<any>(node) && node.props.value === 'accounts') as ReactElement<any>;
    tabs.props.onValueChange('cards');
    const visited = renderPage();
    const cards = find(visited, CardPanel)!;
    find(visited, AccountPanel)!.props.onEdit(mockAccount);
    find(renderPage(), AccountEditor)!.props.onClose();
    expect(sameProps(cards.props, find(renderPage(), CardPanel)!.props)).toBe(true);
  });
  it('does not suppress changed account data', () => {
    const before = find(renderPage(), AccountPanel)!;
    mockConfiguration.data = { ...mockData, revision: 2, accounts: [{ ...mockAccount, enabled: false }] };
    const after = find(renderPage(), AccountPanel)!;
    expect(sameProps(before.props, after.props)).toBe(false);
    expect(after.props.accounts[0].enabled).toBe(false);
  });
  it.each([['other-account', 0], ['synthetic-account', 1]])('preserves save and session refresh for %s', (accountId, refreshCount) => {
    mockAccountId = accountId;
    find(renderPage(), AccountPanel)!.props.onEdit(mockAccount);
    const result = { ...mockData, revision: 2 };
    find(renderPage(), AccountEditor)!.props.onSaved(result, mockAccount.id);
    expect(mockCommit).toHaveBeenCalledWith(result);
    expect(mockRefreshSession).toHaveBeenCalledTimes(refreshCount);
    expect(find(renderPage(), AccountEditor)).toBeUndefined();
  });
  it('opens the exact request from a valid card location and refreshes configuration/session after returned grant', async () => {
    const id = '1b732251-0af2-4916-9e3d-3de527f15ef9';
    mockLocation = { search: `?tab=permission-requests&requestId=${id}`, key: 'card-navigation' };
    const panel = find(renderPage(), PermissionRequestsPanel)!;
    expect(panel.props.focusRequestId).toBe(id); expect(panel.props.focusNavigationKey).toBe('card-navigation');
    await panel.props.onGranted({ status: 'approved' });
    expect(mockConfiguration.refresh).toHaveBeenCalledTimes(1); expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });
  it('treats link parameters only as navigation and never fabricates administrator data', () => {
    mockLocation = { search: '?tab=permission-requests&requestId=1b732251-0af2-4916-9e3d-3de527f15ef9', key: 'card-navigation' };
    mockConfiguration.data = undefined as any;
    expect(find(renderPage(), PermissionRequestsPanel)).toBeUndefined();
    expect(permissionRequestLocation('?tab=permission-requests&requestId=../private')).toEqual({ tab: 'permission-requests' });
    expect(permissionRequestLocation('?tab=permission-requests&requestId=a&requestId=b')).toEqual({ tab: 'permission-requests' });
    expect(permissionRequestLocation('?tab=roles&requestId=1b732251-0af2-4916-9e3d-3de527f15ef9')).toBeNull();
  });
});
