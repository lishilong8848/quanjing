jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { loadConfigurationPeople, loadAuthorizationRoles, loadAccountAuthorization, previewAccountAuthorization, previewAuthorizationRole, saveAccount } from '../../client/src/pages/SystemConfiguration/api';

const http = axiosForBackend as jest.Mock;
const policy = { nativeRole: null, pages: ['/nantong-base'], rules: [] };
const overrides = { rules: [], allowPages: [], denyPages: [] };
describe('unified configuration API contract', () => {
  beforeEach(() => { http.mockReset(); http.mockResolvedValue({ status: 200, data: {} }); });
  it('uses the 60 second people read budget without changing other reads', async () => {
    await loadConfigurationPeople(); expect(http.mock.calls[0][0]).toMatchObject({ url: '/api/access/configuration/people', method: 'GET', timeout: 60_000 });
    await loadAuthorizationRoles(); expect(http.mock.calls[1][0]).toMatchObject({ url: '/api/access/configuration/roles', method: 'GET', timeout: 15_000 });
  });
  it('has distinct read-only effective and preview requests', async () => {
    await loadAccountAuthorization('synthetic/id'); expect(http.mock.calls[0][0].url).toBe('/api/access/configuration/permissions/effective?accountId=synthetic%2Fid');
    const value = { accountId: 'synthetic', expectedRevision: 3, binding: { mode: 'independent' as const, policy }, overrides };
    await previewAccountAuthorization(value); expect(http.mock.calls[1][0]).toMatchObject({ url: '/api/access/configuration/permissions/preview', method: 'POST', data: value });
  });
  it('writes identity and authorization once through accounts', async () => {
    const value = { clientMutationId: 'synthetic-account-mutation', expectedRevision: 3, kind: 'feishu' as const, name: '合成人员', openId: 'ou_synthetic', role: 'guest' as const, building: null, enabled: true, authorizationBinding: { mode: 'independent' as const, policy }, authorizationOverrides: overrides };
    await saveAccount(value); expect(http).toHaveBeenCalledTimes(1); expect(http.mock.calls[0][0]).toMatchObject({ url: '/api/access/configuration/accounts', method: 'POST', data: value });
  });
  it('treats role preview timeouts as reads, not an unconfirmed write', async () => {
    http.mockRejectedValueOnce({ code: 'ECONNABORTED' });
    await expect(previewAuthorizationRole({ clientMutationId: 'synthetic-role-preview', expectedRevision: 3, name: '合成角色', description: '', enabled: true, policy })).rejects.toThrow('读取超时');
  });
});
