jest.mock('@lark-apaas/client-toolkit/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }), { virtual: true });
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => {
  const axios = require('axios');
  const instance = axios.create();
  // Match the SDK's earlier registration: it reads window when the request runs.
  instance.interceptors.request.use((config: any) => {
    if (globalThis.window?.csrfToken) config.headers.set('X-Suda-Csrf-Token', globalThis.window.csrfToken);
    return config;
  });
  return { axiosForBackend: instance };
}, { virtual: true });

import { constructionFetch } from '../../client/src/api/construction-fetch';
import { submitOvertimeConfirmation } from '../../client/src/pages/MonthlySchedule/overtime-confirmation-api';
import { syncMbtiResult } from '../../client/src/pages/MbtiAssessment/mbti-api';

const fresh = 'a'.repeat(43), stale = 'b'.repeat(43);
const descriptors = ['document', 'window', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const browserState = () => ({ csrfToken: stale, setTimeout, clearTimeout, location: { origin: 'http://localhost', href: 'http://localhost/organization' }, dispatchEvent: jest.fn(() => true) });
let cookie = '', browser: ReturnType<typeof browserState>, api: typeof import('../../client/src/api'), sdk: import('axios').AxiosInstance;
const fetchMock = jest.fn(), adapter = jest.fn();
beforeAll(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { get cookie() { return cookie; } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, get: () => browser });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  browser = browserState();
  api = require('../../client/src/api');
  sdk = require('@lark-apaas/client-toolkit/utils/getAxiosForBackend').axiosForBackend;
  sdk.defaults.adapter = adapter;
});
beforeEach(() => {
  cookie = `__Host-suda-csrf-token=${fresh}; suda-csrf-token=${stale}`;
  browser = browserState();
  fetchMock.mockReset(); adapter.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ role: 'guest', syncState: 'success', recordId: 'synthetic', type: 'INTJ' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  adapter.mockImplementation(async (config: unknown) => ({ data: { role: 'guest' }, status: 200, headers: {}, config }));
});
afterAll(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

const requests = [
  ['password login', () => api.loginAccess({ password: 'synthetic-password' })],
  ['construction POST', () => constructionFetch('/api/fixture/protected', { method: 'POST', body: '{}', headers: { 'X-Suda-Csrf-Token': stale } })],
  ['overtime confirmation POST', () => submitOvertimeConfirmation('synthetic', 'synthetic-ticket', 'synthetic-idempotency', {} as never)],
  ['MBTI POST', () => syncMbtiResult({ clientMutationId: 'synthetic', audience: 'active', name: '合成验收', version: 'short', answers: [], sourceSha256: 'synthetic' })],
] as const;

describe('CSRF on browser POST paths', () => {
  it.each(requests)('%s reads the first-party cookie rather than stale state', async (_name, request) => {
    await request();
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Suda-Csrf-Token')).toBe(fresh);
    expect(browser.csrfToken).toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(requests)('%s does not use old cookies, headers, or window after first-party corruption', async (_name, request) => {
    cookie = `__Host-suda-csrf-token=; suda-csrf-token=${stale}`;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message: 'csrf token not match' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    await expect(request()).rejects.toBeTruthy();
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('X-Suda-Csrf-Token')).toBe(false);
    expect(browser.csrfToken).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('syncs SDK logout and generic protected POST before the SDK interceptor runs', async () => {
    await api.logoutAccess();
    expect(adapter.mock.calls[0][0].headers.get('X-Suda-Csrf-Token')).toBe(fresh);
    cookie = `__Host-suda-csrf-token=${stale}`;
    await sdk.post('/api/fixture/protected', {}, { headers: { 'X-Suda-Csrf-Token': fresh } });
    expect(adapter.mock.calls[1][0].headers.get('X-Suda-Csrf-Token')).toBe(stale);
    expect(browser.csrfToken).toBe(stale);
  });
  it('clears explicit stale SDK headers and does not replay a rejected logout or protected POST', async () => {
    cookie = `__Host-suda-csrf-token=${fresh}; __Host-suda-csrf-token=${fresh}; suda-csrf-token=${stale}`;
    adapter.mockImplementation(async (config: unknown) => { throw Object.assign(new Error('rejected'), { config, response: { status: 403 } }); });
    await expect(api.logoutAccess()).rejects.toBeTruthy();
    await expect(sdk.post('/api/fixture/protected', {}, { headers: { 'X-Suda-Csrf-Token': stale } })).rejects.toBeTruthy();
    for (const [config] of adapter.mock.calls) expect(config.headers.has('X-Suda-Csrf-Token')).toBe(false);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(browser.csrfToken).toBe('');
  });
});
