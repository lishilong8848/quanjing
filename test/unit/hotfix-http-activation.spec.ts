import express from 'express';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import type { HotfixActivation } from '../../server/common/hotfix-activation';
import { createHotfixActivationMiddleware } from '../../server/common/hotfix-http-activation';

const HTML_NAVIGATION = { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

describe('real HTTP maintenance boundary', () => {
  let server: Server, port: number, hits = 0, accepting = false;
  let phase: ReturnType<HotfixActivation['status']>['phase'] = 'waiting';
  const deploymentId = 'nantong-safe-full-runtime-hotfix-20261016-000004';
  beforeAll(async () => {
    const app = express();
    app.use(createHotfixActivationMiddleware({ isAcceptingNewWork: () => accepting, status: () => ({ phase, deploymentId }) }, '/tenant/api'));
    app.get('/tenant/api/access/session', (_req, res) => { hits++; res.json({ identity: 'guest' }); });
    app.get('/tenant/api/feishu-card-callback/health', (_req, res) => { hits++; res.json({ enabled: true, ready: true }); });
    app.use((_req, res) => { hits++; res.sendStatus(204); });
    server = await new Promise<Server>(done => { const listening = app.listen(0, '127.0.0.1', () => done(listening)); });
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => { hits = 0; accepting = false; phase = 'waiting'; });
  afterAll(async () => { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); });
  function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body }));
      }); req.on('error', fail); req.end();
    });
  }
  it('rejects reads and writes before their business handler is called', async () => {
    expect((await request('/tenant/api/orders')).status).toBe(503);
    expect((await request('/tenant/api/orders', 'POST')).status).toBe(503);
    expect(hits).toBe(0);
  });
  it('preserves the real read-only session health handler and adds the bound activation state', async () => {
    const result = await request('/tenant/api/access/session');
    expect(result.status).toBe(200); expect(JSON.parse(result.body)).toEqual({ identity: 'guest' });
    expect(result.headers['x-nantong-hotfix-activation']).toBe('waiting');
    expect(result.headers['x-nantong-hotfix-deployment']).toBe(deploymentId);
    expect(result.headers['x-nantong-hotfix-accepting']).toBe('false'); expect(hits).toBe(1);
  });
  it('allows actual WS health while initialization remains protected', async () => {
    phase = 'initializing'; const result = await request('/tenant/api/feishu-card-callback/health');
    expect(result.status).toBe(200); expect(JSON.parse(result.body)).toEqual({ enabled: true, ready: true });
    expect(result.headers['x-nantong-hotfix-accepting']).toBe('false'); expect(hits).toBe(1);
  });
  it('does not extend health exceptions to writes, OAuth callbacks, other prefixes or suffixes', async () => {
    for (const [path, method] of [
      ['/tenant/api/access/session', 'POST'], ['/tenant/api/access/session', 'HEAD'],
      ['/tenant/api/access/session-extra', 'GET'], ['/api/access/session', 'GET'],
      ['/tenant/api/access/feishu/callback?code=synthetic', 'GET'],
    ]) expect((await request(path, method)).status).toBe(503);
    expect(hits).toBe(0);
  });
  it('refuses health when activation has failed rather than presenting readiness', async () => {
    phase = 'failed'; const result = await request('/tenant/api/access/session');
    expect(result.status).toBe(503); expect(hits).toBe(0);
    expect(result.headers['x-nantong-hotfix-activation']).toBe('failed');
  });
  it('does not cache maintenance responses or disclose internal failure details', async () => {
    const result = await request('/tenant/api/orders', 'POST');
    expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers['retry-after']).toBe('5');
    expect(JSON.parse(result.body)).toEqual({ status: 'maintenance', message: '系统更新中，请稍后重试' });
  });
  it('serves a self-contained HTML 503 only to document navigation', async () => {
    const route = '/tenant/monthly-schedule?ticket=synthetic-never-echo';
    const page = await request(route, 'GET', HTML_NAVIGATION);
    expect(page.status).toBe(503);
    expect(page.headers['content-type']).toMatch(/^text\/html; charset=utf-8/i);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['retry-after']).toBe('5');
    expect(page.headers.vary).toBe('Accept, Sec-Fetch-Mode, Sec-Fetch-Dest');
    expect(page.body).toContain('南通基地运营平台');
    expect(page.body).toContain('平台正在更新');
    expect(page.body).toContain('重新尝试');
    expect(page.body).toContain('prefers-reduced-motion');
    expect(page.body).toContain('data-health="/tenant/api/access/session"');
    expect(page.body).not.toContain('synthetic-never-echo');
    expect(page.body).not.toMatch(/<(?:link|script)\b[^>]*(?:src|href)=/i);
    const script = page.body.match(/<script>([\s\S]+)<\/script>/)?.[1] || '';
    expect(script).not.toBe('');
    expect(page.headers['content-security-policy']).toContain(
      `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    );
    const head = await request(route, 'HEAD', HTML_NAVIGATION);
    expect(head).toMatchObject({ status: 503, body: '', headers: { 'content-type': page.headers['content-type'] } });
    expect((await request(route, 'GET', { Accept: 'text/html' })).body).toContain('平台正在更新');
    expect(hits).toBe(0);
  });
  it('keeps JSON for programmatic requests, APIs, and callbacks even with browser headers', async () => {
    for (const [path, method, headers] of [
      ['/tenant/api', 'GET', HTML_NAVIGATION],
      ['/tenant/API/access/feishu/callback?code=synthetic', 'GET', HTML_NAVIGATION],
      ['/api/access/session', 'GET', HTML_NAVIGATION],
      ['/callbacks/feishu/purchase-card', 'POST', HTML_NAVIGATION],
      ['/tenant/api/feishu-card-callback?token=synthetic', 'POST', HTML_NAVIGATION],
      ['/tenant/callbacks/feishu/purchase-card', 'GET', HTML_NAVIGATION],
      ['/tenant/dashboard', 'POST', HTML_NAVIGATION],
      ['/tenant/dashboard', 'GET', { Accept: '*/*' }],
      ['/tenant/dashboard', 'GET', { Accept: 'text/html;q=0,*/*;q=0.5' }],
      ['/tenant/dashboard', 'GET', { Accept: 'text/html;q=0.5,application/json' }],
      ['/tenant/dashboard', 'GET', { ...HTML_NAVIGATION, 'Sec-Fetch-Mode': 'cors' }],
      ['/tenant/dashboard', 'GET', { ...HTML_NAVIGATION, 'Sec-Fetch-Dest': 'script' }],
    ] as const) {
      const result = await request(path, method, headers);
      expect(result.status).toBe(503);
      expect(result.headers['content-type']).toMatch(/^application\/json;/i);
      expect(JSON.parse(result.body)).toMatchObject({ status: 'maintenance' });
    }
    const health = await request('/tenant/api/access/session', 'GET', HTML_NAVIGATION);
    expect(health).toMatchObject({ status: 200, body: '{"identity":"guest"}' });
    phase = 'closed'; accepting = true;
    const closed = await request('/tenant/api/access/session', 'GET', HTML_NAVIGATION);
    expect(closed.status).toBe(503);
    expect(JSON.parse(closed.body)).toMatchObject({ status: 'maintenance' });
    expect(closed.headers['x-nantong-hotfix-accepting']).toBe('false');
    expect(hits).toBe(1);
  });
  it('opens business only after activation and still identifies the real health response', async () => {
    phase = 'active'; accepting = true;
    expect((await request('/tenant/api/orders', 'POST')).status).toBe(204);
    const health = await request('/tenant/api/access/session');
    expect(health.headers['x-nantong-hotfix-accepting']).toBe('true'); expect(hits).toBe(2);
  });

  async function browserScript(fetch: jest.Mock) {
    const html = (await request('/tenant/monthly-schedule', 'GET', HTML_NAVIGATION)).body;
    const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1] || '';
    expect(script).not.toBe('');
    const handlers = new Map<string, (event?: unknown) => void>();
    const status = { textContent: '' };
    const document = {
      hidden: false,
      getElementById: (id: string) => id === 'status' ? status : {
        dataset: { health: '/tenant/api/access/session' },
        addEventListener: (name: string, listener: (event?: unknown) => void) => handlers.set(name, listener),
      },
      addEventListener: (name: string, listener: () => void) => handlers.set(name, listener),
    };
    const location = { origin: 'https://platform.example:3001', reload: jest.fn() };
    jest.useFakeTimers();
    runInNewContext(script, {
      document, location, fetch, AbortController, URL, setTimeout, clearTimeout,
      window: { fetch, AbortController, addEventListener: document.addEventListener },
    });
    return { handlers, status, document, location };
  }

  function healthResponse(phase: string, accepting: string, body: unknown, status = 200) {
    return {
      status,
      headers: new Headers({ 'Content-Type': 'application/json', 'X-Nantong-Hotfix-Activation': phase,
        'X-Nantong-Hotfix-Accepting': accepting, 'X-Nantong-Hotfix-Deployment': deploymentId }),
      json: async () => body,
    };
  }

  it('reloads the original location only after a bound active health response', async () => {
    const valid = { role: 'guest', capabilities: {} };
    const fetch = jest.fn()
      .mockResolvedValueOnce(healthResponse('initializing', 'true', valid))
      .mockResolvedValueOnce(healthResponse('active', 'false', valid))
      .mockResolvedValueOnce(healthResponse('active', 'true', valid, 503))
      .mockResolvedValueOnce(healthResponse('active', 'true', { role: 'guest' }))
      .mockResolvedValueOnce(healthResponse('active', 'true', valid));
    const { location } = await browserScript(fetch);
    try {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(location.reload).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenLastCalledWith(new URL('/tenant/api/access/session', location.origin),
        expect.objectContaining({ method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store' }));
      expect(location.reload).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(35_000);
      expect(fetch).toHaveBeenCalledTimes(5);
    } finally { jest.useRealTimers(); }
  });

  it('backs off on failure, stops in hidden tabs, and resumes by manual check', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('offline'));
    const { handlers, status, document, location } = await browserScript(fetch);
    try {
      await jest.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(status.textContent).toContain('暂时无法连接');
      await jest.advanceTimersByTimeAsync(9_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      document.hidden = true;
      handlers.get('visibilitychange')?.();
      await jest.advanceTimersByTimeAsync(40_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      document.hidden = false;
      handlers.get('visibilitychange')?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      fetch.mockResolvedValueOnce(healthResponse('active', 'true', { role: 'guest', capabilities: {} }));
      const preventDefault = jest.fn();
      handlers.get('click')?.({ preventDefault });
      await jest.advanceTimersByTimeAsync(0);
      expect(preventDefault).toHaveBeenCalled();
      expect(location.reload).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});
