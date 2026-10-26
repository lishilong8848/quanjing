'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions: {
  module: 'CommonJS', target: 'ES2022', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
} });
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const express = require('express');
const { chromium } = require('playwright-core');
const { AccessConfigurationService } = require('../../../server/common/access/access-configuration.service');
const { UnifiedAccessService } = require('../../../server/common/access/unified-access.service');
const { UnifiedAccessController } = require('../../../server/common/access/unified-access.controller');
const { readStrictCookie } = require('../../../server/common/access/unified-access.guard');
const { buildExternalEmployeeCredentials } = require('../../../server/common/access/external-employee-directory');
const output = path.join(root, 'output/playwright/feishu-cookie-migration-' + Date.now());
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cookie-migration-'));
const env = { ...process.env };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = [...Object.keys(require.cache).filter(file => file.startsWith(root + path.sep) && !file.includes(path.sep + 'node_modules' + path.sep)), __filename, process.execPath, path.join(root, 'package-lock.json')];
const fingerprint = () => Object.fromEntries([...new Set(inputs)].sort().map(file => [file, hash(file)]));
const proof = { scope: 'real-controller-config-service-cookie-browser; synthetic-OAuth-provider-only; no-real-cloud', checks: [], failures: [], externalRequests: [], sourceBefore: fingerprint() };
let browser, server;
async function main() {
  const appId = 'cli_cookie_migration_fixture';
  Object.assign(process.env, { ACCESS_CONFIGURATION_FILE: path.join(temporary, 'accounts.json'),
    FEISHU_APP_ID: appId, FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false',
    LOCAL_ACCESS_CONTROL_ENABLED: 'true', LOCAL_ACCESS_SESSION_SECRET: crypto.randomBytes(32).toString('base64') });
  const configuration = new AccessConfigurationService();
  const externalEmployees = await buildExternalEmployeeCredentials([{ record_id: 'recCookieMember', fields: { 姓名: '合成迁移成员', 密码: 'synthetic-cookie-only', '离职/异动情况': false } }], appId, 'fixture', 'table');
  await configuration.synchronizePersonnel({ appId, people: [], employees: [], personnelComplete: true, snapshotAt: Date.now(),
    externalEmployees, activeMembers: [{ name: '合成迁移成员', openId: 'ou_cookie_member', passwordAccountId: externalEmployees[0].id }] });
  const access = new UnifiedAccessService(configuration);
  const principal = configuration.feishuPrincipal('ou_cookie_member', appId);
  assert.equal(principal.role, 'site_member');
  const controller = new UnifiedAccessController(access, {
    sanitizeReturnTo: () => '/', buildAuthorizationUrl: state => '/provider?state=' + encodeURIComponent(state),
    exchangeAuthorizationCode: async code => { assert.equal(code, 'synthetic-provider-code'); return principal; },
  });
  const app = express();
  // Chromium treats localhost as a secure context. Simulate the production TLS proxy at the request boundary.
  app.use((req, _res, next) => { Object.defineProperty(req, 'secure', { value: true }); next(); });
  app.get('/seed-legacy', (req, res) => {
    res.cookie(access.cookieName, access.issueTrustedSession(principal).token, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.redirect('/');
  });
  app.get('/api/access/feishu/authorize', (req, res) => controller.feishuAuthorize('/', req, res));
  app.get('/provider', (req, res) => res.redirect('/api/access/feishu/callback?state=' + encodeURIComponent(req.query.state) + '&code=synthetic-provider-code'));
  app.get('/api/access/feishu/callback', (req, res, next) => controller.feishuCallback(req.query, req, res).catch(next));
  app.get('/api/access/session', (req, res) => {
    const matches = (req.headers.cookie || '').split(';').filter(part => part.trim().startsWith(access.cookieName + '='));
    const cookie = readStrictCookie(req.headers.cookie, access.cookieName);
    const session = controller.session(req, res);
    proof.lastSession = { cookieCount: matches.length, parserAccepted: Boolean(cookie.value), role: session.role, expiresPresent: session.expiresAt !== null };
    res.json(session);
  });
  app.get('/logout', (req, res) => res.json(controller.logout(req, res)));
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><a href="/api/access/feishu/authorize">飞书授权登录</a><output id="identity">确认中</output><script>fetch("/api/access/session",{cache:"no-store",credentials:"same-origin"}).then(r=>r.json()).then(s=>document.querySelector("#identity").textContent=s.principalFingerprint&&s.expiresAt>Date.now()?s.displayName+" / "+s.role:"飞书授权后未确认到登录身份，请重新授权。");</script></html>'));
  server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [name, legacy] of [['clean-desktop', false], ['legacy-mobile', true], ['legacy-desktop', true]]) {
    const context = await browser.newContext({ viewport: name.includes('mobile') ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.route('**/*', route => { if (!route.request().url().startsWith(origin)) { proof.externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.goto(origin + (legacy ? '/seed-legacy' : '/'));
    await page.locator('#identity').filter({ hasNotText: '确认中' }).waitFor();
    if (legacy) assert.equal((await context.cookies()).filter(cookie => cookie.name === access.cookieName && !cookie.partitionKey).length, 1);
    await page.getByRole('link', { name: '飞书授权登录' }).click();
    await page.waitForURL('**/?feishu_auth=success');
    await page.locator('#identity').filter({ hasNotText: '确认中' }).waitFor();
    const visible = await page.locator('#identity').textContent();
    const state = { case: name, ...proof.lastSession, visible,
      cookies: (await context.cookies()).filter(cookie => cookie.name === access.cookieName).map(cookie => ({ secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, partitioned: Boolean(cookie.partitionKey) })) };
    proof.checks.push(state);
    if (visible !== '合成迁移成员 / site_member' || state.cookieCount !== 1) proof.failures.push(name + ': valid callback must establish one readable session');
    await page.screenshot({ path: path.join(output, name + '.png') });
    await page.goto(origin + '/seed-legacy');
    await page.goto(origin + '/logout');
    if ((await context.cookies()).some(cookie => cookie.name === access.cookieName)) proof.failures.push(name + ': logout retained a legacy session cookie');
    await context.close();
  }
  assert.deepEqual(proof.externalRequests, []);
  assert.deepEqual(proof.failures, []);
}
main().catch(error => { proof.error = error.stack; process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  proof.sourceAfter = fingerprint();
  proof.sourceStable = JSON.stringify(proof.sourceBefore) === JSON.stringify(proof.sourceAfter);
  proof.passed = process.exitCode !== 1 && proof.sourceStable;
  fs.rmSync(temporary, { recursive: true, force: true });
  process.env = env;
  proof.cleaned = !fs.existsSync(temporary) && (!server || !server.listening);
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ output, passed: proof.passed, failures: proof.failures, error: proof.error, cleaned: proof.cleaned }));
});
