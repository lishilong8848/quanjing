import { runInNewContext } from 'node:vm';
import { renderTodayOperationsFollowUpPage } from '../../server/modules/bitable-sync/today-operations-follow-up.page';

const first = 'a'.repeat(43), second = 'b'.repeat(43);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function openPage(cookie: string, pathname = '/attendance-anomaly-follow-up', requiresLogin = false) {
  const button = { disabled: false }, result = { className: '', textContent: '' };
  const password = { value: 'synthetic-only-password' }, name = { value: '合成人员' };
  const form = { onsubmit: undefined as any, querySelector: (selector: string) => ({ button, '.result': result, '#login-password': password, '#login-name': name })[selector] };
  const elements: Record<string, any> = {
    content: { innerHTML: '', querySelectorAll: () => [] }, close: {},
    'feishu-login': {}, 'name-login': form,
  };
  const document = { cookie, getElementById: (id: string) => elements[id] };
  const fetch = jest.fn(async () => ({ status: 200, ok: true, json: async () => ({ records: [], actorKey: 'synthetic-actor', canUpdate: true }) }));
  if (requiresLogin) fetch.mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({}) } as never);
  const history = { replaceState: jest.fn() };
  const html = renderTodayOperationsFollowUpPage({ ticket: 'synthetic.ticket' });
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  runInNewContext(script, {
    document, location: { pathname }, history, fetch, Headers, URLSearchParams,
    AbortController, setTimeout, clearTimeout, localStorage: { getItem: () => null }, window: {},
  });
  return { document, elements, fetch, form, password, history };
}

describe('lightweight follow-up page requests', () => {
  it.each([
    [`__Host-suda-csrf-token=${first}; suda-csrf-token=${second}`, first],
    [`suda-csrf-token=${second}`, second],
    [`__Host-suda-csrf-token=invalid; suda-csrf-token=${second}`, null],
    [`__Host-suda-csrf-token=${first}; __Host-suda-csrf-token=${second}; suda-csrf-token=${second}`, null],
    ['', null],
  ])('uses the current unambiguous CSRF cookie without bypassing invalid first-party cookies', async (cookie, expected) => {
    const page = openPage(cookie!);
    await settle();
    const [url, options] = page.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/duty-schedules/daily-operations-follow-ups');
    expect(new Headers(options.headers).get('x-suda-csrf-token')).toBe(expected);
    expect(new Headers(options.headers).get('x-follow-up-ticket')).toBe('synthetic.ticket');
    expect(options.credentials).toBe('same-origin');
    expect(page.elements.content.innerHTML).toContain('当前范围暂无异常');
  });

  it.each(['/attendance-anomaly-follow-up/', '/tenant/attendance-anomaly-follow-up'])('keeps the mounted API and OAuth return path for %s', async pathname => {
    const page = openPage(`suda-csrf-token=${first}`, pathname, true);
    await settle();
    const basePath = pathname.startsWith('/tenant/') ? '/tenant' : '';
    const loginUrl = new URL(page.elements['feishu-login'].href, 'https://synthetic.invalid');
    expect(page.fetch.mock.calls[0][0]).toBe(`${basePath}/api/duty-schedules/daily-operations-follow-ups`);
    expect(loginUrl.pathname).toBe(`${basePath}/api/access/feishu/authorize`);
    expect(loginUrl.searchParams.get('returnTo')).toBe(`${pathname}?ticket=synthetic.ticket`);

    page.document.cookie = `__Host-suda-csrf-token=${second}`;
    await page.form.onsubmit({ preventDefault() {}, currentTarget: page.form });
    const [url, options] = page.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`${basePath}/api/access/login`);
    expect(new Headers(options.headers).get('x-suda-csrf-token')).toBe(second);
    expect(JSON.parse(options.body as string)).toEqual({ employeeName: '合成人员', password: 'synthetic-only-password' });
    expect(page.password.value).toBe('');
    expect(page.elements.content.innerHTML).toContain('当前范围暂无异常');
  });
});
