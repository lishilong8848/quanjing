'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'output/playwright/feishu-first-party-' + Date.now());
fs.mkdirSync(output, { recursive: true });
// All identities, OAuth responses and TLS material belong to this local fixture.
Object.assign(process.env, { LOCAL_ACCESS_CONTROL_ENABLED: 'true',
  LOCAL_ACCESS_SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
  FEISHU_APP_ID: 'cli_synthetic_first_party_browser', CLIENT_BASE_PATH: '' });
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions: {
  module: 'CommonJS', target: 'ES2022', experimentalDecorators: true,
  emitDecoratorMetadata: true, esModuleInterop: true,
} });
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
for (const [file, exports] of [['server/runtime-env.ts', {}], ['server/app.module.ts', { AppModule: class {} }]]) {
  const filename = path.join(root, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const express = require('express');
const cookieParser = require('cookie-parser');
const { chromium } = require('playwright-core');
const { UnifiedAccessService } = require('../../../server/common/access/unified-access.service');
const { UnifiedAccessController } = require('../../../server/common/access/unified-access.controller');
const { FIRST_PARTY_ACCESS_COOKIE_NAME, readAccessCookie, writeAccessCookie } = require('../../../server/common/access/unified-access.guard');
const { createStandaloneCsrfSeedMiddleware, createApiCsrfValidationMiddleware, FIRST_PARTY_CSRF_COOKIE_NAME } = require('../../../server/main');
const files = [...new Set([...Object.keys(require.cache).filter(file => file.startsWith(root + path.sep) &&
  !file.includes(path.sep + 'node_modules' + path.sep)), __filename, path.join(root, 'package-lock.json'), process.execPath])].sort();
const fingerprint = () => Object.fromEntries(files.map(file => [path.relative(root, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const proof = { scope: 'Local HTTPS browser + real session controller/cookies/CSRF; synthetic OAuth; simulated Partitioned rejection',
  passed: false, checks: [], externalRequests: [], sourceBefore: fingerprint() };
let browser, server, mode = 'normal', origin, embeddedOrigin, protectedWrites = 0;
const principal = { role: 'editor', purchaseBuilding: null, displayName: '合成本地登录人员' };
const access = new UnifiedAccessService();
const controller = new UnifiedAccessController(access, {
  sanitizeReturnTo: () => '/', buildAuthorizationUrl: state => '/provider?state=' + encodeURIComponent(state),
  exchangeAuthorizationCode: async code => { assert.equal(code, 'local-fixture-code'); return principal; },
});

async function main() {
  assert.equal(typeof readAccessCookie, 'function');
  assert.ok(FIRST_PARTY_ACCESS_COOKIE_NAME && FIRST_PARTY_CSRF_COOKIE_NAME);
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const set = res.setHeader.bind(res);
    res.setHeader = (name, values) => {
      if (name.toLowerCase() === 'set-cookie' && mode !== 'normal') {
        values = (Array.isArray(values) ? values : [values]).filter(value => !/;\s*Partitioned(?:;|$)/i.test(value) &&
          (mode !== 'old-policy-control' || !value.startsWith('__Host-')));
        if (!values.length) { res.removeHeader(name); return res; }
      }
      return set(name, values);
    };
    next();
  });
  app.use(cookieParser());
  app.use(createStandaloneCsrfSeedMiddleware());
  app.get('/provider', (req, res) => res.redirect('/api/access/feishu/callback?state=' + encodeURIComponent(req.query.state) + '&code=local-fixture-code'));
  app.use('/api', createApiCsrfValidationMiddleware());
  app.get('/api/access/feishu/authorize', (req, res) => controller.feishuAuthorize('/', req, res));
  app.get('/api/access/feishu/callback', (req, res, next) => controller.feishuCallback(req.query, req, res).catch(next));
  app.get('/api/access/session', (req, res) => res.json(controller.session(req, res)));
  app.post('/api/access/logout', (req, res) => res.json(controller.logout(req, res)));
  app.post('/api/protected-fixture', (req, res) => {
    const cookie = readAccessCookie(req.headers.cookie, access);
    const identity = access.readSessionIdentity(cookie.value);
    if (identity.principal.role !== 'editor') return res.status(401).json({ accepted: false });
    protectedWrites++;
    res.json({ accepted: true });
  });
  app.get('/seed-legacy', (_req, res) => {
    res.cookie(access.cookieName, access.issueTrustedSession(principal, Date.now() - 10000).token,
      { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.redirect('/');
  });
  app.get('/seed-partitioned', (_req, res) => {
    res.cookie(access.cookieName, access.issueTrustedSession({ ...principal, displayName: '旧合成本地人员' }, Date.now() - 10000).token,
      { httpOnly: true, secure: true, sameSite: 'none', path: '/', partitioned: true });
    res.redirect('/');
  });
  app.get('/fixture-embedded-session', (req, res) => {
    writeAccessCookie(res, req, access.cookieName, access.issueTrustedSession(principal), Date.now());
    res.redirect('/');
  });
  app.get('/embed', (_req, res) => res.type('html').send(`<iframe title="local fixture" src="${origin}/fixture-embedded-session"></iframe>`));
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>当前项目本地会话验证</title>' +
    '<a href="/api/access/feishu/authorize">飞书授权登录</a><script>window.csrfToken=' + JSON.stringify(res.locals.csrfToken) + '</script></html>'));
  const tls = await require('selfsigned').generate([{ name: 'commonName', value: 'localhost' }], {
    days: 1, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' },
    ] }],
  });
  server = https.createServer({ key: tls.private, cert: tls.cert }, app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'https://127.0.0.1:' + server.address().port;
  embeddedOrigin = 'https://localhost:' + server.address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const read = (page, route = 'session', method = 'GET', token) => page.evaluate(async ({ route, method, token }) => {
    const response = await fetch('/api/' + (route === 'protected-fixture' ? route : 'access/' + route), {
      method, credentials: 'same-origin', headers: { 'x-suda-csrf-token': token === undefined ? window.csrfToken : token },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = {}; }
    return { status: response.status, body };
  }, { route, method, token });
  for (const scenario of ['old-policy-control', 'normal', 'drop-partitioned', 'legacy-drop-partitioned', 'retained-partitioned']) {
    mode = scenario === 'old-policy-control' ? scenario : scenario === 'normal' ? 'normal' : 'drop-partitioned';
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => {
      if (![origin, embeddedOrigin].includes(new URL(route.request().url()).origin)) {
        proof.externalRequests.push(route.request().url()); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    if (scenario === 'retained-partitioned') mode = 'normal';
    await page.goto(origin + (scenario.startsWith('legacy') ? '/seed-legacy' : scenario === 'retained-partitioned' ? '/seed-partitioned' : '/'));
    if (scenario === 'retained-partitioned') {
      const before = await read(page);
      proof.retainedBefore = { status: before.status, role: before.body.role,
        cookies: (await context.cookies()).map(({ name, domain, path, sameSite, partitionKey }) => ({ name, domain, path, sameSite, partitionKey })) };
      assert.equal(before.body.displayName, '旧合成本地人员');
      mode = 'drop-partitioned';
    }
    await page.getByRole('link', { name: '飞书授权登录' }).click();
    await page.waitForURL('**/?feishu_auth=success');
    const session = await read(page);
    if (scenario === 'old-policy-control') {
      assert.equal(session.status, 403);
      assert.equal((await read(page, 'protected-fixture', 'POST')).status, 403);
      proof.checks.push({ scenario, qualification: 'Both new first-party cookies suppressed to model original policy', sessionRead: 403, protectedPost: 403 });
      await context.close(); continue;
    }
    assert.equal(session.status, 200); assert.equal(session.body.role, 'editor');
    assert.equal(session.body.displayName, principal.displayName);
    assert.equal((await read(page, 'protected-fixture', 'POST')).status, 200);
    assert.equal((await read(page, 'protected-fixture', 'POST', 'invalid')).status, 403);
    const cookies = await context.cookies();
    const first = cookies.find(cookie => cookie.name === FIRST_PARTY_ACCESS_COOKIE_NAME);
    assert.ok(first && first.httpOnly && first.secure && first.sameSite === 'Lax' && !first.partitionKey);
    assert.ok(cookies.some(cookie => cookie.name === FIRST_PARTY_CSRF_COOKIE_NAME && cookie.secure && !cookie.httpOnly));
    if (mode === 'drop-partitioned' && scenario !== 'retained-partitioned') assert.ok(cookies.every(cookie => !cookie.partitionKey));
    if (scenario === 'retained-partitioned') {
      assert.ok(cookies.some(cookie => cookie.name === access.cookieName && cookie.partitionKey));
    }
    assert.equal((await read(page, 'logout', 'POST')).status, 200);
    assert.equal((await read(page)).body.role, 'guest');
    assert.equal((await read(page, 'protected-fixture', 'POST')).status, 401);
    proof.checks.push({ scenario, login: 'editor', protectedPost: 200, invalidCsrf: 403, logout: 'guest', unauthorizedPost: 401 });
    await context.close();
  }
  mode = 'normal';
  const embedded = await browser.newContext({ ignoreHTTPSErrors: true });
  await embedded.route('**/*', route => {
    if (![origin, embeddedOrigin].includes(new URL(route.request().url()).origin)) {
      proof.externalRequests.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  const page = await embedded.newPage();
  await page.goto(embeddedOrigin + '/embed');
  await page.frameLocator('iframe').getByRole('link', { name: '飞书授权登录' }).waitFor();
  const frame = page.frames().find(item => item !== page.mainFrame());
  assert.equal((await read(frame)).body.role, 'editor');
  assert.equal((await read(frame, 'protected-fixture', 'POST')).status, 200);
  assert.ok((await embedded.cookies()).some(cookie => cookie.name === access.cookieName && cookie.partitionKey));
  proof.checks.push({ scenario: 'cross-site iframe session compatibility (synthetic session seed, no OAuth)', role: 'editor', protectedPost: 200, partitioned: true });
  await embedded.close();
  assert.equal(protectedWrites, 5);
  assert.deepEqual(proof.externalRequests, []);
  proof.passed = true;
}
main().catch(error => { proof.error = error.stack; process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  proof.sourceAfter = fingerprint();
  proof.sourceStable = JSON.stringify(proof.sourceBefore) === JSON.stringify(proof.sourceAfter);
  proof.passed &&= proof.sourceStable;
  proof.cleaned = !server || !server.listening;
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ output, passed: proof.passed, checks: proof.checks, error: proof.error, cleaned: proof.cleaned }));
  if (!proof.passed) process.exitCode = 1;
});
