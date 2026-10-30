jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }), { virtual: true });
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { createArchiveCorrection, listOwnArchiveCorrections, cancelPermissionRequest, getAdminArchiveCorrectionSummary, reviewArchiveCorrection } from '../../client/src/api/personal-access';
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let mockFetch: jest.Mock;
describe('private self-service request transport', () => {
  beforeEach(() => { jest.clearAllMocks(); mockFetch = jest.fn(); Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch }); });
  afterEach(() => { jest.useRealTimers(); if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else Reflect.deleteProperty(globalThis, 'fetch'); expect(axiosForBackend).not.toHaveBeenCalled(); });
  it.each(['Forbidden，csrf token header must be singular.', 'Forbidden，csrf token not found or invalid in cookie.', 'Forbidden，csrf token not found or invalid in header.', 'Forbidden，csrf token not match.'])('maps a fixed plain-text middleware error safely: %s', async text => {
    mockFetch.mockResolvedValue(new Response(text, { status: 403 }));
    await expect(createArchiveCorrection({ clientMutationId: 'synthetic', fields: ['phone'], description: '合成说明' })).rejects.toThrow('登录页面已过期，请刷新页面后重试。');
  });
  it('does not echo unknown text or JSON containing private information', async () => {
    for (const result of [new Response('Forbidden csrf token secret=synthetic', { status: 403 }), response({ message: 'private phone=synthetic' }, 400)]) {
      mockFetch.mockResolvedValueOnce(result);
      const error = await createArchiveCorrection({ clientMutationId: 'synthetic', fields: ['phone'], description: '合成说明' }).catch(value => value);
      expect(error.message).not.toMatch(/synthetic|private|secret/); expect(error).not.toHaveProperty('response'); expect(error).not.toHaveProperty('cause');
    }
  });
  it('accepts list arrays, rejects unexpected list shapes and uses only fixed self endpoints', async () => {
    mockFetch.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({}));
    await expect(listOwnArchiveCorrections()).resolves.toEqual([]); await expect(listOwnArchiveCorrections()).rejects.toThrow('读取失败');
    expect(mockFetch.mock.calls[0][0]).toBe('/api/access/personal/archive-corrections');
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  });
  it('retains exact versions and mutation ids for cancellation and administrator feedback', async () => {
    mockFetch.mockImplementation(async () => response({ id: 'request', version: 3 }));
    const body = { requestId: 'request', expectedRequestVersion: 2, clientMutationId: 'same-retry' };
    await cancelPermissionRequest(body); await reviewArchiveCorrection({ ...body, decision: 'resolve', comment: '已核对合成资料' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(body);
    expect(mockFetch.mock.calls[1][0]).toBe('/api/access/configuration/archive-corrections');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ ...body, decision: 'resolve', comment: '已核对合成资料' });
  });
  it('uses a bounded 15-second budget for correction and permission data without automatic retries', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private details')))));
    const waiting = expect(getAdminArchiveCorrectionSummary()).rejects.toMatchObject({ status: 408 });
    await jest.advanceTimersByTimeAsync(14_999); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); await waiting; expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
