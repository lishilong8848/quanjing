const mockFetch = jest.fn(), mockAxios = jest.fn();
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: (...args: unknown[]) => mockAxios(...args) }));
import { saveAccount } from '../../client/src/pages/SystemConfiguration/api';
import type { AccountMutation } from '../../shared/access-configuration.interface';

const originals = new Map(['fetch', 'document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const oldBase = process.env.CLIENT_BASE_PATH;
const body = { clientMutationId: 'synthetic-account-request', expectedRevision: 10, kind: 'local', id: 'shared', name: 'Synthetic', role: 'guest', building: null, enabled: true, password: 'Synthetic-Sensitive-Password' } as AccountMutation;
const configuration = { revision: 11, appId: 'synthetic', accounts: [{ id: 'shared', name: 'Synthetic', enabled: true }], cardRules: [], audit: [] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('configuration account private save', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockFetch.mockReset(); delete process.env.CLIENT_BASE_PATH;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (oldBase === undefined) delete process.env.CLIENT_BASE_PATH; else process.env.CLIENT_BASE_PATH = oldBase;
    expect(mockAxios).not.toHaveBeenCalled();
  });
  it('routes the real editor save through native same-origin transport with latest CSRF and caller mutation identity', async () => {
    document.cookie = `__Host-suda-csrf-token=${'a'.repeat(43)}`;
    mockFetch.mockResolvedValue(json(configuration));
    await expect(saveAccount(body)).resolves.toEqual(configuration);
    expect(mockFetch).toHaveBeenCalledWith('/api/access/configuration/accounts', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(body);
    expect(mockFetch.mock.calls[0][1].headers['X-Suda-Csrf-Token']).toBe('a'.repeat(43));
  });
  it.each([400, 401, 403, 409, 429, 500])('never copies untrusted private response text into a status %i error', async status => {
    mockFetch.mockResolvedValue(json({ message: body.password }, status));
    const error = await saveAccount(body).catch(value => value);
    expect(error.status).toBe(status); expect(error.uncertain).toBe(status >= 500);
    expect(String(error)).not.toContain(body.password); expect(JSON.stringify(error)).not.toContain(body.password);
    expect(error).not.toHaveProperty('response'); expect(error).not.toHaveProperty('config'); expect(error).not.toHaveProperty('cause');
  });
  it.each(['Forbidden，csrf token not found or invalid in cookie.', 'Forbidden，csrf token not found or invalid in header.'])('recognizes known plain CSRF failure without telling users to discard their draft', async message => {
    mockFetch.mockResolvedValue(new Response(message, { status: 403 }));
    await expect(saveAccount(body)).rejects.toMatchObject({ message: '页面已过期，请刷新页面后重试；当前草稿已保留。', status: 403, uncertain: false });
  });
  it('keeps the same request identity across an uncertain timeout and explicit retry, without automatic retries', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(String(body.password))))));
    const result = expect(saveAccount(body)).rejects.toMatchObject({ status: 408, uncertain: true });
    await jest.advanceTimersByTimeAsync(14_999); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); await result; expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockResolvedValueOnce(json(configuration)); await saveAccount(body);
    expect(mockFetch.mock.calls[0][1].body).toBe(mockFetch.mock.calls[1][1].body);
  });
  it.each([null, { revision: 11 }, { ...configuration, revision: 9 }, { ...configuration, accounts: [null] }])('treats malformed or stale success as uncertain, retaining draft recovery', async data => {
    mockFetch.mockResolvedValue(json(data)); await expect(saveAccount(body)).rejects.toMatchObject({ uncertain: true });
  });
  it.each(['https://external.invalid', '..', '%2fexternal', '%2e%2e', 'a?x=1', 'a\\b', 'a//b'])('rejects unsafe base %s before sending', async base => {
    process.env.CLIENT_BASE_PATH = base; await expect(saveAccount(body)).rejects.toThrow('地址无效'); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('supports a mounted local path', async () => {
    process.env.CLIENT_BASE_PATH = '/platform/'; mockFetch.mockResolvedValue(json(configuration)); await saveAccount(body);
    expect(mockFetch.mock.calls[0][0]).toBe('/platform/api/access/configuration/accounts');
  });
});
