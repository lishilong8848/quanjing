// Local browser fixture: real page/controllers and signed sessions, synthetic identities/data only.
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: {
  module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true,
} });
require('tsconfig-paths').register({ baseUrl: root, paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] } });
const port = 32120, origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  LOCAL_ACCESS_CONTROL_ENABLED: 'true', LOCAL_ACCESS_SESSION_SECRET: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: origin, NANTONG_DAILY_PATROL_PUBLIC_BASE_URL: `http://localhost:${port}`,
  CLIENT_BASE_PATH: '', FEISHU_APP_ID: 'cli_synthetic_followup',
  DAILY_OPERATIONS_FOLLOW_UP_TICKET_SECRET: 'synthetic-local-ticket-secret-only',
});
const { UnifiedAccessService } = require('../../server/common/access/unified-access.service');
const { FeishuAccessService } = require('../../server/common/access/feishu-access.service');
const { UnifiedAccessController } = require('../../server/common/access/unified-access.controller');
const { writeAccessCookie, clearAccessCookie } = require('../../server/common/access/unified-access.guard');
const { TodayOperationsFollowUpController } = require('../../server/modules/bitable-sync/today-operations-follow-up.controller');
const { TodayOperationsFollowUpTicketService } = require('../../server/modules/bitable-sync/today-operations-follow-up.ticket');
const actor = { role: 'editor', purchaseBuilding: null, accountId: `feishu-${'a'.repeat(64)}`, authorizationVersion: 1, displayName: '本地测试人员' };
const access = new UnifiedAccessService({
  validateSession: (id, version) => id === actor.accountId && version === actor.authorizationVersion,
  currentPrincipal: () => actor,
  pagePermissions: () => ({ paths: ['/monthly-schedule'], configured: true, revision: 1 }),
});
const config = { PUBLIC_BASE_URL: origin, FEISHU_APP_ID: process.env.FEISHU_APP_ID, FEISHU_APP_SECRET: 'synthetic-provider-secret', FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false' };
const feishu = new FeishuAccessService({ get: key => config[key] }, {});
feishu.exchangeAuthorizationCode = async code => {
  assert.equal(code, 'synthetic-local-provider-code');
  return actor;
};
const auth = new UnifiedAccessController(access, feishu);
const tickets = new TodayOperationsFollowUpTicketService();
const metrics = { authorize: 0, provider: 0, callback: 0, list: 0, businessWrites: 0 };
const followup = new TodayOperationsFollowUpController(tickets, {
  async listFollowUps() {
    metrics.list++;
    return [{ recordId: 'rec_synthetic', item: '本地巡视异常', date: '2026-10-28', source: '运维巡视', building: 'H楼', description: '用于验证已登录直达与授权后返回，不连接实际业务数据。', acknowledged: false, completed: false, treatmentMeasure: '' }];
  },
  updateFollowUp() { throw new Error('Business writes are disabled in this fixture'); },
}, access);
const express = require('express');
const app = express();
const cardUrl = () => tickets.issueUrl({ from: '2026-10-27', through: '2026-10-28' });
const htmlEscape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const issueSession = (req, res) => writeAccessCookie(res, req, access.cookieName, access.issueTrustedSession(actor), Date.now());
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/fixture/:mode', (req, res, next) => {
  if (!['existing', 'anonymous', 'preview'].includes(req.params.mode)) return next();
  if (req.params.mode === 'anonymous') clearAccessCookie(res, req, access.cookieName);
  else issueSession(req, res);
  const url = cardUrl();
  assert.equal(new URL(url).origin, origin, 'New card must use the login origin, not the patrol override');
  if (req.params.mode === 'preview') return res.redirect(302, url);
  res.type('html').send(`<html lang="zh-CN"><meta charset="utf-8"><title>本地卡片测试</title><h1>${req.params.mode === 'existing' ? '已有登录会话' : '未登录'}</h1><a href="${htmlEscape(url)}">打开新卡片：异常跟进</a></html>`);
});
app.get('/fixture/metrics', (_req, res) => res.json(metrics));
app.get('/api/access/feishu/authorize', (req, res) => {
  metrics.authorize++;
  const redirect = res.redirect.bind(res);
  res.redirect = (status, value) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://accounts.feishu.cn');
    assert.equal(url.searchParams.get('redirect_uri'), feishu.getCallbackUrl());
    return redirect(status, `http://localhost:${port}/fixture/provider?${url.searchParams}`);
  };
  auth.feishuAuthorize(req.query.returnTo, req, res);
});
app.get('/fixture/provider', (req, res) => {
  metrics.provider++;
  const callback = new URL(feishu.getCallbackUrl());
  callback.searchParams.set('state', String(req.query.state));
  callback.searchParams.set('code', 'synthetic-local-provider-code');
  res.type('html').send(`<html lang="zh-CN"><meta charset="utf-8"><title>本地模拟授权</title><h1>本地模拟飞书授权</h1><a href="${htmlEscape(callback)}">确认模拟授权</a></html>`);
});
app.get('/api/access/feishu/callback', (req, res, next) => {
  metrics.callback++;
  auth.feishuCallback(req.query, req, res).catch(next);
});
app.get('/attendance-anomaly-follow-up', (req, res, next) => {
  try {
    if (req.query.preview === '1') issueSession(req, res);
    res.send(followup.page(req.query.ticket, res));
  } catch (error) { next(error); }
});
app.get('/api/duty-schedules/daily-operations-follow-ups', (req, res, next) =>
  followup.list(req.headers['x-follow-up-ticket'], req).then(value => res.json(value)).catch(next));
app.all('*', (_req, res) => res.status(405).json({ message: 'Fixture route is not available' }));
app.use((error, _req, res, _next) => res.status(error.getStatus?.() || 500).json({ message: error.message }));
const server = app.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, origin, externalRequests: 0, businessWrites: 0 })));
server.on('error', error => { console.error(error.code || 'FIXTURE_START_FAILED'); process.exitCode = 1; });
process.on('SIGINT', () => server.close(() => process.exit(0)));
