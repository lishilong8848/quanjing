import { runInNewContext } from 'node:vm';
import { FeishuAccessService } from '../../server/common/access/feishu-access.service';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { writeAccessCookie } from '../../server/common/access/unified-access.guard';
import { ACCESS_SESSION_TTL_MS, UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { TodayOperationsFollowUpController } from '../../server/modules/bitable-sync/today-operations-follow-up.controller';
import { TodayOperationsFollowUpTicketService, issueTodayOperationsFollowUpTicket } from '../../server/modules/bitable-sync/today-operations-follow-up.ticket';

const publicBase = 'https://www.sm.sjhl.online:3001';
const ticketSecret = 'synthetic-followup-ticket-secret-only';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(baseUrl = publicBase, role = 'editor') {
  process.env.PUBLIC_BASE_URL = baseUrl;
  const config: Record<string, string> = {
    PUBLIC_BASE_URL: baseUrl, FEISHU_APP_ID: 'cli_followup_fixture',
    FEISHU_APP_SECRET: 'synthetic-oauth-secret-only', FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false',
  };
  const principal = { role, accountId: `feishu-${'a'.repeat(64)}`, authorizationVersion: 1, displayName: '合成测试', purchaseBuilding: null };
  const access = new UnifiedAccessService({
    validateSession: (id: string, version: number, candidateRole: string) =>
      id === principal.accountId && version === principal.authorizationVersion && candidateRole === principal.role,
    currentPrincipal: () => principal,
    pagePermissions: () => ({ paths: ['/today-operations-panorama'], configured: true, revision: 1 }),
  } as never);
  jest.spyOn(access, 'issueTrustedSession');
  const feishu = new FeishuAccessService({ get: (key: string) => config[key] } as never, {} as never);
  const exchange = jest.spyOn(feishu, 'exchangeAuthorizationCode').mockResolvedValue(principal as never);
  const oauth = new UnifiedAccessController(access as never, feishu);
  const tickets = new TodayOperationsFollowUpTicketService();
  const business = { listFollowUps: jest.fn(async () => [{
    recordId: 'synthetic-record', item: '合成巡视异常', description: '仅限本地测试',
    date: '2026-10-29', source: '每日巡视', building: 'A楼', treatmentMeasure: '',
  }]) };
  const followup = new TodayOperationsFollowUpController(tickets, business as never, access as never);

  // Cookie hosts deliberately stay separate: a shared jar would hide this regression.
  const cookies = new Map<string, Map<string, string>>();
  function jar(url: URL) {
    if (!cookies.has(url.hostname)) cookies.set(url.hostname, new Map());
    return cookies.get(url.hostname)!;
  }
  function request(url: URL) {
    return { secure: true, protocol: 'https', socket: {}, headers: {
      host: url.host, cookie: [...jar(url)].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '),
    } };
  }
  function response(url: URL) {
    let redirect = '';
    return {
      setHeader: jest.fn(), type: jest.fn(),
      cookie: (name: string, value: string, options: { domain?: string }) => {
        expect(options.domain).toBeUndefined(); jar(url).set(name, value);
      },
      clearCookie: (name: string) => { jar(url).delete(name); },
      redirect: (_status: number, value: string) => { redirect = new URL(value, url).toString(); },
      destination: () => new URL(redirect),
    };
  }
  const cardUrl = new URL(tickets.issueUrl({ from: '2026-10-29', through: '2026-10-29' }));
  function signInAt(url: URL, issuedAt = Date.now()) {
    const session = access.issueTrustedSession(principal as never, issuedAt);
    // Retain stale signed tokens too, so the server must reject them even if sent.
    writeAccessCookie(response(url) as never, request(url) as never, access.cookieName,
      session, Date.now());
  }
  async function openPage(url: URL) {
    const html = followup.page(url.searchParams.get('ticket')!, response(url) as never);
    const elements: Record<string, any> = {
      content: { innerHTML: '', querySelectorAll: () => [] }, close: {}, retry: {}, 'feishu-login': {}, 'name-login': {},
    };
    const statuses: number[] = [];
    const fetch = jest.fn(async (input: string, options: RequestInit) => {
      const target = new URL(input, url);
      expect(target.origin).toBe(url.origin);
      const basePath = url.pathname.replace(/\/attendance-anomaly-follow-up\/?$/u, '');
      expect(target.pathname).toBe(`${basePath}/api/duty-schedules/daily-operations-follow-ups`);
      expect(options.credentials).toBe('same-origin');
      expect(options.method || 'GET').toBe('GET');
      try {
        const data = await followup.list(new Headers(options.headers).get('x-follow-up-ticket')!, request(target) as never);
        statuses.push(200);
        return { status: 200, ok: true, json: async () => data };
      } catch (error) {
        const failure = error as { getStatus(): number; message: string };
        statuses.push(failure.getStatus());
        return { status: failure.getStatus(), ok: false, json: async () => ({ message: failure.message }) };
      }
    });
    runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1], {
      document: { cookie: '', getElementById: (id: string) => elements[id] },
      location: { pathname: url.pathname }, history: { replaceState: jest.fn() }, window: {},
      fetch, Headers, URLSearchParams, AbortController, setTimeout, clearTimeout,
      localStorage: { getItem: () => null },
    });
    await settle();
    return { elements, fetch, statuses };
  }
  function authorize(loginUrl: URL) {
    const result = response(loginUrl);
    oauth.feishuAuthorize(loginUrl.searchParams.get('returnTo'), request(loginUrl) as never, result as never);
    return result.destination();
  }
  async function callback(providerUrl: URL, state = providerUrl.searchParams.get('state')!) {
    const url = new URL(providerUrl.searchParams.get('redirect_uri')!);
    const result = response(url);
    await oauth.feishuCallback({ code: 'synthetic-code', state }, request(url) as never, result as never);
    return result.destination();
  }
  return { access, feishu, exchange, business, cardUrl, openPage, authorize, callback, signInAt,
    revokeSession: () => { principal.authorizationVersion += 1; } };
}

describe('new patrol card and OAuth login round trip', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_followup_fixture';
    process.env.DAILY_OPERATIONS_FOLLOW_UP_TICKET_SECRET = ticketSecret;
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 23).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    process.env.CLIENT_BASE_PATH = '';
    delete process.env.NANTONG_DAILY_PATROL_PUBLIC_BASE_URL;
  });
  afterEach(() => { process.env = { ...saved }; jest.restoreAllMocks(); });

  it.each([publicBase, 'https://sm.sjhl.online:3001'])('keeps the configured OAuth origin in new cards: %s', base => {
    const f = fixture(base);
    expect(f.cardUrl.origin).toBe(new URL(f.feishu.getCallbackUrl()).origin);
  });

  it('reuses an existing platform login and loads the card records without another authorization', async () => {
    const f = fixture();
    f.signInAt(new URL(publicBase));
    const page = await f.openPage(f.cardUrl);
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(page.statuses).toEqual([200]);
    expect(page.elements.content.innerHTML).toContain('合成巡视异常');
    expect(page.elements.content.innerHTML).not.toContain('飞书授权登录');
    expect(page.elements['feishu-login'].href).toBeUndefined();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it('authorizes once and returns to the original ticket with a usable session', async () => {
    const f = fixture(), page = await f.openPage(f.cardUrl);
    expect(page.statuses).toEqual([401]);
    expect(page.elements.content.innerHTML).toContain('飞书授权登录');
    const loginUrl = new URL(page.elements['feishu-login'].href, f.cardUrl);
    expect(loginUrl.searchParams.get('returnTo')).toBe(f.cardUrl.pathname + f.cardUrl.search);
    const returned = await f.callback(f.authorize(loginUrl));
    expect(returned.origin).toBe(f.cardUrl.origin);
    expect(returned.pathname).toBe('/attendance-anomaly-follow-up');
    expect(returned.searchParams.get('ticket')).toBe(f.cardUrl.searchParams.get('ticket'));
    expect(returned.searchParams.get('feishu_auth')).toBe('success');
    const authenticated = await f.openPage(returned);
    expect(authenticated.statuses).toEqual([200]);
    expect(authenticated.elements.content.innerHTML).toContain('合成巡视异常');
    expect(authenticated.elements.content.innerHTML).not.toContain('飞书授权登录');
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.access.issueTrustedSession).toHaveBeenCalledTimes(1);
  });

  it('does not exchange a code or grant a session when OAuth state is invalid', async () => {
    const f = fixture(), page = await f.openPage(f.cardUrl);
    const provider = f.authorize(new URL(page.elements['feishu-login'].href, f.cardUrl));
    const returned = await f.callback(provider, 'wrong-synthetic-state');
    expect(returned.searchParams.get('feishu_auth')).toBe('state_invalid');
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.access.issueTrustedSession).not.toHaveBeenCalled();
    expect(f.business.listFollowUps).not.toHaveBeenCalled();
  });

  it('shows an authenticated permission rejection without starting another login loop', async () => {
    const f = fixture(publicBase, 'guest');
    f.signInAt(new URL(publicBase));
    const page = await f.openPage(f.cardUrl);
    expect(page.statuses).toEqual([403]);
    expect(page.elements.content.innerHTML).toContain('当前账号暂无异常跟进权限');
    expect(page.elements.content.innerHTML).not.toContain('飞书授权登录');
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(f.business.listFollowUps).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it.each(['expired', 'revoked'])('requires a fresh login for a %s signed session, then returns to the same record scope', async reason => {
    const f = fixture();
    f.signInAt(f.cardUrl, reason === 'expired' ? Date.now() - ACCESS_SESSION_TTL_MS - 1 : Date.now());
    if (reason === 'revoked') f.revokeSession();
    const page = await f.openPage(f.cardUrl);
    expect(page.statuses).toEqual([401]);
    expect(f.business.listFollowUps).not.toHaveBeenCalled();
    const returned = await f.callback(f.authorize(new URL(page.elements['feishu-login'].href, f.cardUrl)));
    expect(returned.searchParams.get('feishu_auth')).toBe('success');
    expect(returned.searchParams.get('ticket')).toBe(f.cardUrl.searchParams.get('ticket'));
    expect((await f.openPage(returned)).statuses).toEqual([200]);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it.each(['tampered', 'expired', 'another-app'])('rejects a %s follow-up ticket before displaying or reading business records', async reason => {
    const f = fixture();
    f.signInAt(f.cardUrl);
    const invalid = new URL(f.cardUrl);
    invalid.searchParams.set('ticket', reason === 'tampered'
      ? `${f.cardUrl.searchParams.get('ticket')}x`
      : issueTodayOperationsFollowUpTicket({
        from: '2026-10-29', through: '2026-10-29',
        issuedAt: Date.now() - (reason === 'expired' ? 36 * 24 * 60 * 60_000 : 0),
        appId: reason === 'another-app' ? 'cli_another_fixture' : 'cli_followup_fixture',
      }, ticketSecret));
    await expect(f.openPage(invalid)).rejects.toThrow(/令牌/);
    expect(f.business.listFollowUps).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it('keeps a valid configured base path through the first authorization and list request', async () => {
    const f = fixture(`${publicBase}/portal`), page = await f.openPage(f.cardUrl);
    const loginUrl = new URL(page.elements['feishu-login'].href, f.cardUrl);
    expect(loginUrl.pathname).toBe('/portal/api/access/feishu/authorize');
    const returned = await f.callback(f.authorize(loginUrl));
    expect(returned.pathname).toBe('/portal/attendance-anomaly-follow-up');
    expect(returned.searchParams.get('ticket')).toBe(f.cardUrl.searchParams.get('ticket'));
    expect(returned.searchParams.get('feishu_auth')).toBe('success');
    expect((await f.openPage(returned)).statuses).toEqual([200]);
  });

  it.each(['https://attacker.invalid/path', '//attacker.invalid/path', '/%2f%2fattacker.invalid/path', '/\\attacker.invalid/path'])(
    'does not redirect to the malicious returnTo %s', async returnTo => {
      const f = fixture(), loginUrl = new URL('/api/access/feishu/authorize', publicBase);
      loginUrl.searchParams.set('returnTo', returnTo);
      const returned = await f.callback(f.authorize(loginUrl));
      expect(returned.origin).toBe(publicBase);
      expect(returned.pathname).toBe('/monthly-schedule');
      expect(returned.searchParams.get('feishu_auth')).toBe('success');
    },
  );

  it('does not let an earlier concurrent authorization callback erase the newer authorization', async () => {
    const f = fixture(), page = await f.openPage(f.cardUrl);
    const loginUrl = new URL(page.elements['feishu-login'].href, f.cardUrl);
    const earlier = f.authorize(loginUrl), later = f.authorize(loginUrl);
    expect(earlier.searchParams.get('state')).not.toBe(later.searchParams.get('state'));
    expect((await f.callback(earlier)).searchParams.get('feishu_auth')).toBe('state_invalid');
    const returned = await f.callback(later);
    expect(returned.searchParams.get('feishu_auth')).toBe('success');
    expect((await f.openPage(returned)).statuses).toEqual([200]);
  });

  it.each(['earlier', 'duplicate'])('does not log out a completed login when an %s callback arrives later', async kind => {
    const f = fixture(), page = await f.openPage(f.cardUrl);
    const loginUrl = new URL(page.elements['feishu-login'].href, f.cardUrl);
    const earlier = f.authorize(loginUrl), later = f.authorize(loginUrl);
    const returned = await f.callback(later);
    expect(returned.searchParams.get('feishu_auth')).toBe('success');
    expect((await f.openPage(returned)).statuses).toEqual([200]);
    const rejected = await f.callback(kind === 'earlier' ? earlier : later);
    expect(rejected.searchParams.get('feishu_auth')).toBe('state_invalid');
    expect((await f.openPage(f.cardUrl)).statuses).toEqual([200]);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
});
