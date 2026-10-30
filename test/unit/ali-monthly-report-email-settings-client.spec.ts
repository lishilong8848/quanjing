const mockFetch = jest.fn(), mockAxios = jest.fn();
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: (...args: unknown[]) => mockAxios(...args) }), { virtual: true });
import { getAliMonthlyReportEmailSettings, MonthlyEmailSettingsError, saveAliMonthlyReportEmailSettings } from '../../client/src/api/ali-monthly-report-email-settings';

const originals = new Map(['fetch', 'document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalBase = process.env.CLIENT_BASE_PATH;
const settings = { senderEmail: '123456@qq.com', authCodeConfigured: true, source: 'server', revision: 'r1', updatedAt: null, canSave: true };
const request = { senderEmail: '123456@qq.com', authCode: 'SyntheticCode123', expectedRevision: 'r1', clientMutationId: 'synthetic-request-01' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('monthly report email settings private transport', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockFetch.mockReset(); delete process.env.CLIENT_BASE_PATH;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (originalBase === undefined) delete process.env.CLIENT_BASE_PATH; else process.env.CLIENT_BASE_PATH = originalBase;
    expect(mockAxios).not.toHaveBeenCalled();
  });
  it('uses only same-origin fetch and never retains a returned authorization code or raw issue', async () => {
    mockFetch.mockResolvedValue(json({ ...settings, authCode: 'should-never-reach-ui', issue: 'raw-private-detail' }));
    await expect(getAliMonthlyReportEmailSettings()).resolves.toEqual(settings);
    expect(mockFetch).toHaveBeenCalledWith('/api/ali-monthly-report/email-settings', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
  });
  it('uses the latest CSRF cookie when saving and preserves the caller mutation id', async () => {
    (document as { cookie: string }).cookie = `__Host-suda-csrf-token=${'a'.repeat(43)}`;
    mockFetch.mockResolvedValue(json({ success: true, settings, config: { reportTypes: [], missingConfigKeys: [], emailReady: true } }));
    await saveAliMonthlyReportEmailSettings(request);
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers['X-Suda-Csrf-Token']).toBe('a'.repeat(43)); expect(JSON.parse(init.body)).toEqual(request);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  });
  it.each([400, 401, 403, 409, 429, 500])('does not copy raw private error data for status %s', async status => {
    mockFetch.mockResolvedValue(new Response('synthetic-private-auth-code', { status }));
    const failure = await saveAliMonthlyReportEmailSettings(request).catch(error => error);
    expect(failure).toBeInstanceOf(MonthlyEmailSettingsError); expect(failure.status).toBe(status);
    expect(String(failure)).not.toContain('synthetic-private'); expect(failure).not.toHaveProperty('response');
    expect(failure.uncertain).toBe(status >= 500);
  });
  it('enforces 15 seconds, aborts and never automatically repeats an uncertain save', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('native error containing private input')))));
    const waiting = expect(saveAliMonthlyReportEmailSettings(request)).rejects.toMatchObject({ status: 408, uncertain: true });
    await jest.advanceTimersByTimeAsync(14_999); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); await waiting; expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(getAliMonthlyReportEmailSettings(controller.signal)).rejects.toMatchObject({ cancelled: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('treats a malformed success body as an uncertain save without leaking it', async () => {
    mockFetch.mockResolvedValue(json({ success: true, authCode: 'raw-secret' }));
    await expect(saveAliMonthlyReportEmailSettings(request)).rejects.toMatchObject({ uncertain: true });
  });
  it.each(['https://external.invalid', '../escape', '%2fexternal', 'a?x=1'])('rejects unsafe base path %s before dispatch', async base => {
    process.env.CLIENT_BASE_PATH = base;
    await expect(getAliMonthlyReportEmailSettings()).rejects.toThrow('地址无效'); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('supports a configured local base path', async () => {
    process.env.CLIENT_BASE_PATH = '/platform/'; mockFetch.mockResolvedValue(json(settings));
    await getAliMonthlyReportEmailSettings(); expect(mockFetch.mock.calls[0][0]).toBe('/platform/api/ali-monthly-report/email-settings');
  });
});
