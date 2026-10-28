jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });
jest.mock('@/api', () => ({ getAccessSession: jest.fn() }), { virtual: true });

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getAccessSession } from '@/api';
import type { AccessSessionResponse } from '../../shared/access-control.interface';
import { requestImpersonation } from '../../client/src/access/impersonation';

const admin = (): AccessSessionResponse => ({ role: 'admin', purchaseBuilding: null, accountId: 'synthetic-admin', displayName: '合成管理员',
  expiresAt: Date.now() + 60_000, principalFingerprint: 'synthetic-admin-fingerprint', capabilities: { canEdit: true, canDelete: true, canForceRefresh: true, canAccessContracts: true } });
const target = (): AccessSessionResponse => ({ ...admin(), role: 'guest', accountId: 'synthetic-target', displayName: '合成人员',
  principalFingerprint: 'synthetic-target-fingerprint', effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [] }, overrides: { rules: [], allowPages: [], denyPages: [] } },
  impersonation: { actorAccountId: 'synthetic-admin', actorName: '合成管理员', targetName: '合成人员', expiresAt: Date.now() + 60_000 } });
const request = () => ({ action: 'start' as const, actorAccountId: 'synthetic-admin', accountId: 'synthetic-target', clientMutationId: 'synthetic-mutation-001' });

describe('administrator impersonation identity confirmation', () => {
  beforeEach(() => { jest.clearAllMocks(); (axiosForBackend as jest.Mock).mockResolvedValue({ status: 200 }); (getAccessSession as jest.Mock).mockReset().mockResolvedValueOnce(admin()).mockResolvedValue(target()); });
  it('posts only target identity and mutation ID, then reads the actual cookie session', async () => {
    const result = await requestImpersonation(request());
    expect(result.accountId).toBe('synthetic-target');
    expect(axiosForBackend).toHaveBeenCalledWith({ url: '/api/access/impersonation/start', method: 'POST', timeout: 15_000,
      data: { accountId: 'synthetic-target', clientMutationId: 'synthetic-mutation-001' } });
    expect(getAccessSession).toHaveBeenCalledTimes(2);
  });
  it('confirms a successful mutation after a lost response without sending another mutation', async () => {
    (axiosForBackend as jest.Mock).mockRejectedValue({ code: 'ECONNABORTED' });
    await expect(requestImpersonation(request())).resolves.toMatchObject({ accountId: 'synthetic-target' });
    expect(axiosForBackend).toHaveBeenCalledTimes(1);
  });
  it('checks uncertain outcomes before retry and avoids repeating an already completed change', async () => {
    (getAccessSession as jest.Mock).mockReset().mockResolvedValue(target());
    await expect(requestImpersonation(request())).resolves.toMatchObject({ accountId: 'synthetic-target' });
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('retries an unchanged administrator identity with the same request ID', async () => {
    (getAccessSession as jest.Mock).mockReset().mockResolvedValueOnce(admin()).mockResolvedValueOnce(target());
    await requestImpersonation(request());
    expect(getAccessSession).toHaveBeenCalledTimes(2);
    expect((axiosForBackend as jest.Mock).mock.calls[0][0].data.clientMutationId).toBe('synthetic-mutation-001');
  });
  it('does not retry against an unexpected identity', async () => {
    (getAccessSession as jest.Mock).mockReset().mockResolvedValue({ ...target(), accountId: 'synthetic-other' });
    await expect(requestImpersonation(request())).rejects.toMatchObject({ currentSession: { accountId: 'synthetic-other' } });
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('preserves a confirmed unchanged session and the server rejection reason', async () => {
    (axiosForBackend as jest.Mock).mockRejectedValue({ response: { status: 403, data: { message: '该账号当前不能登录' } } });
    (getAccessSession as jest.Mock).mockReset().mockResolvedValue(admin());
    await expect(requestImpersonation(request())).rejects.toMatchObject({ message: '该账号当前不能登录', currentSession: { accountId: 'synthetic-admin' } });
  });
  it('marks an unconfirmed identity as unknown so the caller can block stale controls', async () => {
    (getAccessSession as jest.Mock).mockReset().mockRejectedValue(new Error('synthetic offline'));
    await expect(requestImpersonation(request())).rejects.toMatchObject({ outcomeUnknown: true });
    jest.clearAllMocks();
    await expect(requestImpersonation(request())).rejects.toMatchObject({ outcomeUnknown: true });
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('restores only the original administrator and never accepts a nested/other administrator context', async () => {
    const stopping = { action: 'stop' as const, actorAccountId: 'synthetic-admin', clientMutationId: 'synthetic-stop-001' };
    (getAccessSession as jest.Mock).mockReset().mockResolvedValueOnce(target()).mockResolvedValue(admin());
    await expect(requestImpersonation(stopping)).resolves.toMatchObject({ role: 'admin', accountId: 'synthetic-admin' });
    expect((axiosForBackend as jest.Mock).mock.calls[0][0]).toMatchObject({ url: '/api/access/impersonation/stop', data: { clientMutationId: 'synthetic-stop-001' } });
    for (const session of [{ ...admin(), accountId: 'other-admin' }, { ...admin(), impersonation: target().impersonation }]) {
      (getAccessSession as jest.Mock).mockReset().mockResolvedValue(session);
      await expect(requestImpersonation(stopping)).rejects.toMatchObject({ currentSession: session });
    }
  });
  it('does not confirm expired, anonymous, or unbound impersonation sessions', async () => {
    for (const current of [{ ...target(), expiresAt: Date.now() - 1 }, { ...target(), principalFingerprint: null },
      { ...target(), impersonation: { ...target().impersonation!, actorAccountId: 'other-admin' } }]) {
      (getAccessSession as jest.Mock).mockReset().mockResolvedValue(current);
      await expect(requestImpersonation(request())).rejects.toMatchObject({ currentSession: current });
    }
  });
});
