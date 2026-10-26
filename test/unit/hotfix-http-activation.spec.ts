import express from 'express';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HotfixActivation } from '../../server/common/hotfix-activation';
import { createHotfixActivationMiddleware } from '../../server/common/hotfix-http-activation';

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
  function request(path: string, method = 'GET') {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
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
  it('opens business only after activation and still identifies the real health response', async () => {
    phase = 'active'; accepting = true;
    expect((await request('/tenant/api/orders', 'POST')).status).toBe(204);
    const health = await request('/tenant/api/access/session');
    expect(health.headers['x-nantong-hotfix-accepting']).toBe('true'); expect(hits).toBe(2);
  });
});
