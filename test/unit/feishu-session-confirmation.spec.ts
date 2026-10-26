import type { AccessSessionResponse } from '../../shared/access-control.interface';
import { createFeishuSessionConfirmation, getIdentityRequestError } from '../../client/src/access/feishu-auth';
import { createSessionCommitCoordinator } from '../../client/src/access/session-commit-coordinator';

const guest: AccessSessionResponse = {
  role: 'guest', purchaseBuilding: null, expiresAt: null, principalFingerprint: null,
  capabilities: { canEdit: false, canDelete: false, canForceRefresh: false, canAccessContracts: false },
};
const authenticated = (): AccessSessionResponse => ({ ...guest, role: 'editor', principalFingerprint: 'synthetic-test', expiresAt: Date.now() + 3600000 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Feishu session confirmation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('waits for a pre-authorization read and shares one in-flight confirmation', async () => {
    const oldRefresh = deferred<void>();
    const read = jest.fn().mockResolvedValue(authenticated());
    const coordinator = createSessionCommitCoordinator();
    const refreshToken = coordinator.captureRefresh();
    const confirmation = createFeishuSessionConfirmation(read, coordinator);
    const result = confirmation.run(oldRefresh.promise);
    expect(confirmation.run()).toBe(result);
    expect(confirmation.isPending()).toBe(true);
    expect(coordinator.canCommit(refreshToken)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    oldRefresh.resolve();
    expect((await result).status).toBe('confirmed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(confirmation.isPending()).toBe(false);
  });

  it('accepts the third read when the WebView session becomes available within the bounded delay', async () => {
    const valid = authenticated();
    const read = jest.fn().mockResolvedValueOnce(guest).mockResolvedValueOnce({ ...guest, sessionCookieStatus: 'absent' }).mockResolvedValueOnce(valid);
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    const result = confirmation.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(749);
    expect(read).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 'confirmed', session: valid });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('reports a persistent missing session after exactly three reads and allows explicit retry', async () => {
    const read = jest.fn().mockResolvedValue({ ...guest, sessionCookieStatus: 'absent' });
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    const result = confirmation.run();
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ status: 'unconfirmed', message: expect.stringContaining('没有收到登录会话') });
    expect(read).toHaveBeenCalledTimes(3);
    read.mockResolvedValue(authenticated());
    expect((await confirmation.run()).status).toBe('confirmed');
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(['duplicate', 'malformed', 'rejected', 'disabled'])('does not retry the definitive %s diagnostic', async sessionCookieStatus => {
    const read = jest.fn().mockResolvedValue({ ...guest, sessionCookieStatus });
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect((await confirmation.run()).status).toBe('unconfirmed');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: 'ECONNABORTED' }, '身份确认超时'],
    [{ code: 'ERR_NETWORK' }, '暂时无法连接身份服务'],
    [{ response: { status: 401 } }, '登录会话已失效'],
    [{ response: { status: 403, data: { message: '请求被拒绝' } } }, '请求被拒绝'],
    [{ response: { status: 503, data: { message: '稍后再试' } } }, '身份服务暂不可用：稍后再试'],
  ])('does not retry a request error or turn it into a missing-session error', async (error, message) => {
    const read = jest.fn().mockRejectedValue(error);
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect(await confirmation.run()).toMatchObject({ status: 'request_error', message: expect.stringContaining(message as string) });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('accepts an authenticated guest and distinguishes an expired identity', async () => {
    const read = jest.fn().mockResolvedValue({ ...authenticated(), role: 'guest', sessionCookieStatus: 'valid' });
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect((await confirmation.run()).status).toBe('confirmed');
    read.mockResolvedValue({ ...authenticated(), expiresAt: Date.now() - 1 });
    expect(await confirmation.run()).toMatchObject({ status: 'unconfirmed', message: '登录会话已过期，请重新登录。' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves older valid Feishu guest sessions without accountId or diagnostic headers', async () => {
    const read = jest.fn().mockResolvedValue({ ...authenticated(), role: 'guest' });
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect(await confirmation.run()).toMatchObject({ status: 'confirmed', session: { role: 'guest' } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown-role', undefined, ''])('rejects an unknown role despite a fingerprint and future expiry', async role => {
    const read = jest.fn().mockResolvedValue({ ...authenticated(), role });
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect((await confirmation.run()).status).toBe('unconfirmed');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('cancels further guest reads when login/logout supersedes the waiting confirmation', async () => {
    const read = jest.fn().mockResolvedValue(guest);
    const coordinator = createSessionCommitCoordinator();
    const confirmation = createFeishuSessionConfirmation(read, coordinator);
    const result = confirmation.run();
    await jest.advanceTimersByTimeAsync(0);
    coordinator.beginMutation();
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ status: 'superseded' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'error'])('ignores a late old %s after a newer session is committed', async outcome => {
    const old = deferred<AccessSessionResponse>();
    const current = authenticated();
    const read = jest.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
    const coordinator = createSessionCommitCoordinator();
    const confirmation = createFeishuSessionConfirmation(read, coordinator);
    const pending = confirmation.run();
    await jest.advanceTimersByTimeAsync(0);
    coordinator.beginMutation();
    const newest = await confirmation.run();
    expect(newest.status).toBe('confirmed');
    if (outcome === 'success') old.resolve(guest);
    else old.reject(new Error('old network error'));
    expect(await pending).toEqual({ status: 'superseded' });
    expect(newest.status !== 'superseded' && coordinator.canCommit(newest.token)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not start a read when cancelled while waiting for the old refresh', async () => {
    const old = deferred<void>();
    const read = jest.fn();
    const coordinator = createSessionCommitCoordinator();
    const confirmation = createFeishuSessionConfirmation(read, coordinator);
    const result = confirmation.run(old.promise);
    coordinator.beginMutation();
    old.resolve();
    expect(await result).toEqual({ status: 'superseded' });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not consume the same history entry after URL cleanup or header remount', () => {
    const confirmation = createFeishuSessionConfirmation(jest.fn(), createSessionCommitCoordinator());
    expect(confirmation.consumeCallback('first:/organization?feishu_auth=success')).toBe(true);
    expect(confirmation.hasConsumedCallback('clean:/organization')).toBe(false);
    expect(confirmation.consumeCallback('first:/organization?feishu_auth=success')).toBe(false);
    expect(confirmation.consumeCallback('other:/monthly-schedule?feishu_auth=success')).toBe(true);
    expect(confirmation.consumeCallback('first:/organization?feishu_auth=success')).toBe(false);
  });

  it('accepts a new authorization attempt at the same URL after an earlier failure', async () => {
    const read = jest.fn().mockRejectedValueOnce({ code: 'ERR_NETWORK' }).mockResolvedValueOnce(authenticated());
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    expect(confirmation.consumeCallback('first:/organization?feishu_auth=success')).toBe(true);
    expect((await confirmation.run()).status).toBe('request_error');
    expect(confirmation.consumeCallback('second:/organization?feishu_auth=success')).toBe(true);
    expect((await confirmation.run()).status).toBe('confirmed');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('coalesces a bfcache resume with an in-flight confirmation and permits a later explicit retry', async () => {
    const response = deferred<AccessSessionResponse>();
    const read = jest.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce(authenticated());
    const confirmation = createFeishuSessionConfirmation(read, createSessionCommitCoordinator());
    const key = 'first:/organization?feishu_auth=success';
    expect(confirmation.consumeCallback(key)).toBe(true);
    const pending = confirmation.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(confirmation.consumeCallback(key)).toBe(false);
    expect(confirmation.run()).toBe(pending);
    response.reject({ code: 'ERR_NETWORK' });
    expect((await pending).status).toBe('request_error');
    expect((await confirmation.run()).status).toBe('confirmed');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retains a meaningful ordinary Error and safely handles non-object failures', () => {
    expect(getIdentityRequestError(new Error('身份服务响应无效'))).toBe('身份服务响应无效');
    expect(getIdentityRequestError(null)).toBe('登录身份确认失败，请重试。');
    expect(getIdentityRequestError({ response: { status: 403, data: { message: ['请求被拒绝', '请重新登录'] } } })).toBe('请求被拒绝；请重新登录');
  });
});
