const mockAxios = jest.fn(), mockFetch = jest.fn();
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: (...args: unknown[]) => mockAxios(...args) }), { virtual: true });
import { getPersonalArchive, getPersonalArchivePhoto } from '../../client/src/api/personal-access';

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalBase = process.env.CLIENT_BASE_PATH;
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('personal archive private transport boundary', () => {
  beforeEach(() => {
    mockAxios.mockReset(); mockFetch.mockReset(); delete process.env.CLIENT_BASE_PATH;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, descriptor] of [['fetch', originalFetch], ['document', originalDocument], ['window', originalWindow]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    if (originalBase === undefined) delete process.env.CLIENT_BASE_PATH; else process.env.CLIENT_BASE_PATH = originalBase;
    expect(mockAxios).not.toHaveBeenCalled();
  });
  it('loads the current user only with private same-origin transport and no SDK telemetry', async () => {
    const response = { status: 'unbound', profile: null, snapshotAt: null };
    mockFetch.mockResolvedValue(jsonResponse(response));
    await expect(getPersonalArchive()).resolves.toEqual(response);
    expect(mockFetch).toHaveBeenCalledWith('/api/access/personal/archive', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(mockFetch.mock.calls[0][0]).not.toMatch(/accountId|recordId|name=/);
  });
  it('honors a local deployment prefix and reads the current CSRF cookie each time', async () => {
    process.env.CLIENT_BASE_PATH = '/panorama/';
    const token = 'A'.repeat(43);
    (document as any).cookie = `__Host-suda-csrf-token=${token}`;
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'unbound', profile: null, snapshotAt: null }));
    await getPersonalArchive();
    expect(mockFetch.mock.calls[0][0]).toBe('/panorama/api/access/personal/archive');
    expect(mockFetch.mock.calls[0][1].headers['X-Suda-Csrf-Token']).toBe(token);
    (document as any).cookie = '__Host-suda-csrf-token=invalid';
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'unbound', profile: null, snapshotAt: null }));
    await getPersonalArchive();
    expect(mockFetch.mock.calls[1][1].headers).not.toHaveProperty('X-Suda-Csrf-Token');
  });
  it.each(['https://other.invalid', '\\other.invalid', '/%2fother.invalid', '/safe/../private', '/safe?token=x'])('rejects unsafe deployment prefixes without a request: %s', async prefix => {
    process.env.CLIENT_BASE_PATH = prefix;
    await expect(getPersonalArchive()).rejects.toThrow('地址配置无效');
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('combines caller cancellation without leaking the native fetch error', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('sensitive native failure')))));
    const result = getPersonalArchive(controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow('读取已取消');
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(getPersonalArchive(controller.signal)).rejects.toThrow('读取已取消');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it('aborts at 60 seconds and never retries a private request automatically', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private native error')))));
    const result = expect(getPersonalArchive()).rejects.toMatchObject({ status: 408 });
    await jest.advanceTimersByTimeAsync(59_999); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); await result;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it.each(['image/png', 'image/jpeg', 'image/webp'])('fetches %s from the fixed current-user photo endpoint', async type => {
    const blob = new Blob(['synthetic image'], { type });
    mockFetch.mockResolvedValue(new Response(blob, { status: 200, headers: { 'Content-Type': type } }));
    const result = await getPersonalArchivePhoto();
    expect(result.type).toBe(type); expect(result.size).toBe(blob.size);
    expect(mockFetch).toHaveBeenCalledWith('/api/access/personal/archive/photo', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
  });
  it('accepts an existing nine MiB onboarding photograph instead of applying a lower display limit', async () => {
    const blob = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/png' });
    mockFetch.mockResolvedValue(new Response(blob));
    expect((await getPersonalArchivePhoto()).size).toBe(blob.size);
  });
  it.each([
    () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response(new Blob([], { type: 'image/png' })),
    () => new Response(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' })),
    () => new Response('synthetic photo', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(10 * 1024 * 1024 + 1) } }),
    () => jsonResponse({ file_token: 'synthetic-token' }),
    () => new Response('denied', { status: 403, headers: { 'Content-Type': 'image/png' } }),
  ])('rejects malformed, oversized, non-image or denied photo responses', async response => {
    mockFetch.mockResolvedValue(response());
    await expect(getPersonalArchivePhoto()).rejects.toThrow('个人照片读取失败');
  });
  it('exposes no upstream response or native request details in errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'identity=synthetic-private phone=synthetic-mobile password=secret' }, 400));
    const error = await getPersonalArchive().catch(failure => failure);
    expect(error.message).toBe('个人档案读取失败，请重试');
    expect(error).not.toHaveProperty('response'); expect(error).not.toHaveProperty('config'); expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toMatch(/identity|phone|password|secret/);
    mockFetch.mockRejectedValueOnce(new Error('token=synthetic-secret identity=synthetic-private'));
    await expect(getPersonalArchivePhoto()).rejects.toThrow(/^个人照片读取失败，请重试$/);
  });
  it('preserves a fixed actionable identity-matching failure without exposing its raw response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: '登录账号未唯一匹配到人员，请联系管理员核对', extra: 'synthetic-private' }, 403));
    const error = await getPersonalArchive().catch(failure => failure);
    expect(error.message).toBe('登录账号未唯一匹配到人员，请联系管理员核对');
    expect(error.status).toBe(403); expect(error).not.toHaveProperty('response');
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  });
});
