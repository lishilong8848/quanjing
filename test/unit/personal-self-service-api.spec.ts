jest.mock('@lark-apaas/client-toolkit/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }), { virtual: true });
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { changePersonalPassword, resetPersonalPassword, listOwnPermissionRequests, getPersonalProfile, reviewPermissionRequest } from '../../client/src/api/personal-access';
import { loginAccess } from '../../client/src/api';
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let privateFetch: jest.Mock;

describe('personal password and permission transport boundaries', () => {
  beforeEach(() => { jest.clearAllMocks(); privateFetch = jest.fn(); Object.defineProperty(globalThis, 'fetch', { configurable: true, value: privateFetch }); });
  afterEach(() => { jest.useRealTimers(); if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else Reflect.deleteProperty(globalThis, 'fetch'); });
  it('uses 60 seconds for credential updates and forwards exact passwords with the original mutation id', async () => {
    privateFetch.mockImplementation(async () => response({ success: true }));
    const body = { currentPassword: ' old password ', newPassword: ' new password ', confirmPassword: ' new password ', clientMutationId: 'synthetic-id' };
    await changePersonalPassword(body); await changePersonalPassword(body);
    expect(privateFetch).toHaveBeenNthCalledWith(1, '/api/access/personal/password/change', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify(body), headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }));
    expect(privateFetch.mock.calls[1][1].body).toBe(JSON.stringify(body));
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('does not silently treat incomplete or unconfirmed responses as a password success', async () => {
    const body = { employeeName: '合成', identityNumber: 'synthetic-only', newPassword: 'synthetic-password', confirmPassword: 'synthetic-password', clientMutationId: 'synthetic-id' };
    privateFetch.mockResolvedValueOnce(response({}));
    await expect(resetPersonalPassword(body)).rejects.toMatchObject({ uncertain: true });
    privateFetch.mockRejectedValueOnce(new Error('native failure with synthetic request content'));
    await expect(resetPersonalPassword(body)).rejects.toThrow('可能已更新');
    privateFetch.mockResolvedValueOnce(response({ message: '过期' }, 401));
    await expect(resetPersonalPassword(body)).rejects.toThrow('尝试新密码登录');
    expect(privateFetch).toHaveBeenCalledTimes(3);
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('preserves backend validation errors, and personal reads never accept someone else account id', async () => {
    privateFetch.mockResolvedValueOnce(response({ message: '两次密码不一致' }, 400));
    await expect(changePersonalPassword({ currentPassword: 'synthetic', newPassword: 'synthetic', confirmPassword: 'synthetic', clientMutationId: 'synthetic-id' })).rejects.toThrow('两次密码不一致');
    privateFetch.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ displayName: '合成人员' }));
    await listOwnPermissionRequests(); await getPersonalProfile();
    expect(privateFetch).toHaveBeenNthCalledWith(2, '/api/access/personal/permission-requests', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    expect(privateFetch).toHaveBeenNthCalledWith(3, '/api/access/personal/profile', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('keeps password timeouts uncertain at 60 seconds without automatic retries or SDK logs', async () => {
    jest.useFakeTimers();
    privateFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private password body must not survive')))));
    const result = expect(changePersonalPassword({ currentPassword: 'secret-old', newPassword: 'secret-new', confirmPassword: 'secret-new', clientMutationId: 'same-mutation' })).rejects.toMatchObject({ uncertain: true, status: 408 });
    await jest.advanceTimersByTimeAsync(59_999); expect(privateFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); await result;
    expect(privateFetch).toHaveBeenCalledTimes(1); expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('never attaches private payloads or raw backend messages to password failures', async () => {
    privateFetch.mockResolvedValueOnce(response({ message: 'password=secret-new identity=synthetic-private' }, 400));
    const error = await resetPersonalPassword({ employeeName: '合成', identityNumber: 'synthetic-private', newPassword: 'secret-new', confirmPassword: 'secret-new', clientMutationId: 'same-mutation' }).catch(failure => failure);
    expect(error.message).toBe('密码请求未通过校验，请核对后重试');
    expect(error).not.toHaveProperty('config'); expect(error).not.toHaveProperty('request'); expect(error).not.toHaveProperty('response'); expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toMatch(/secret|synthetic-private|identity|employeeName/);
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('passes the specific request version to administrator review, never an authorization grant', async () => {
    privateFetch.mockResolvedValueOnce(response({ id: 'synthetic-request', version: 5 }));
    const body = { clientMutationId: 'synthetic-id', requestId: 'synthetic-request', expectedRequestVersion: 4, decision: 'approve' as const };
    await reviewPermissionRequest(body);
    expect(privateFetch).toHaveBeenCalledWith('/api/access/configuration/permission-requests', expect.objectContaining({ method: 'POST', body: JSON.stringify(body), credentials: 'same-origin' }));
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('allows a fresh named-person login 60 seconds without retrying automatically', async () => {
    jest.useFakeTimers();
    let aborted = false;
    const fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetch });
    const pending = expect(loginAccess({ employeeName: '合成人员', password: 'synthetic-password' })).rejects.toMatchObject({ response: { status: 408 } });
    await jest.advanceTimersByTimeAsync(59_999); expect(aborted).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); await pending; expect(aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
