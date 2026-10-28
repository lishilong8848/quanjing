jest.mock('@/access/AccessProvider', () => ({ useAccess: jest.fn() }), { virtual: true });
jest.mock('@/components/FeishuIcon', () => ({ FeishuIcon: () => null }), { virtual: true });
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });
jest.mock('../../client/src/pages/SystemConfiguration/model', () => ({ ROLE_LABELS: {}, accountStatus: jest.fn(), accountAuthorizationKey: jest.fn(), accountAuthorizationLabel: jest.fn() }));
import type { ManagedAccount } from '../../shared/access-configuration.interface';
import { canImpersonateAccount } from '../../client/src/pages/SystemConfiguration/AccountPanel';
const account = (): ManagedAccount => ({ id: 'synthetic-person', name: '合成人员', kind: 'local', role: 'guest', building: null, enabled: true, deleted: false, version: 1, source: 'configuration' });
describe('impersonation entry uses actual account status, never a role grant', () => {
  it.each(['admin', 'guest', 'editor', 'inventory_admin'] as const)('permits a valid %s account', role => {
    expect(canImpersonateAccount({ ...account(), role })).toBe(true);
  });
  it.each([{ enabled: false }, { deleted: true }, { personnelActive: false }, { reactivationRequired: true }, { permissionsRevoked: true }])('rejects an account unavailable for login: %j', state => {
    expect(canImpersonateAccount({ ...account(), ...state })).toBe(false);
  });
  it('keeps an explicitly allowed named-guest login while rejecting inactive personnel', () => {
    expect(canImpersonateAccount({ ...account(), permissionsRevoked: true, guestLoginAllowed: true })).toBe(true);
    expect(canImpersonateAccount({ ...account(), permissionsRevoked: true, guestLoginAllowed: true, personnelActive: false })).toBe(false);
  });
});
