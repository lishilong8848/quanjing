const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/feishu-guest-login-check/browser');
const mocks = path.join(root, 'test/fixtures/feishu-login-browser/api.ts');
const { rspack } = require('@rspack/core');
const compiler = rspack({
  context: root, mode: 'development', devtool: false, target: 'web',
  entry: path.join(root, 'test/fixtures/feishu-guest-browser/entry.tsx'),
  output: { path: output, filename: 'app.js', cssFilename: 'app.css', publicPath: '/' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], alias: {
    '@/api$': mocks, '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared'),
    '@lark-apaas/client-toolkit/logger$': mocks,
    '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': mocks,
    '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$': mocks,
    '@lark-apaas/client-toolkit/dataloom$': mocks,
  } },
  module: { rules: [
    { test: /\.svg$/, type: 'asset/inline' },
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
    { test: /\.css$/, type: 'css/auto', use: { loader: 'postcss-loader', options: { postcssOptions: { plugins: { '@tailwindcss/postcss': {} } } } } },
  ] },
  experiments: { css: true },
  plugins: [new (require('@rspack/core').DefinePlugin)({ 'process.env.CLIENT_BASE_PATH': JSON.stringify('') })],
});
const started = Date.now();
compiler.run((error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    compiler.close(() => {}); process.exitCode = 1;
  } else compiler.close(() => start(Date.now() - started));
});

function start(compileMs) {
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] } });
  const { FeishuAccessService } = require('../../server/common/access/feishu-access.service');
  const { UnifiedAccessService, ACCESS_SESSION_TTL_MS } = require('../../server/common/access/unified-access.service');
  const { UnifiedAccessController } = require('../../server/common/access/unified-access.controller');
  const { UnifiedAccessGuard } = require('../../server/common/access/unified-access.guard');
  const { GuestReadableMetadataKey } = require('../../server/common/access/unified-access.decorators');
  process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
  process.env.LOCAL_ACCESS_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
  process.env.FEISHU_APP_ID = 'cli_guest_browser_fixture';
  const config = { FEISHU_APP_ID: process.env.FEISHU_APP_ID, FEISHU_APP_SECRET: 'fixture-only', PUBLIC_BASE_URL: 'http://127.0.0.1:43215', FEISHU_ACCESS_ADMIN_OPEN_IDS: 'ou_fixture_admin' };
  const feishu = new FeishuAccessService({ get: key => config[key] }, { axiosRef: {
    post: async (_url, body) => {
      if (!['fixture-guest', 'fixture-admin'].includes(body.code)) throw new Error('Only synthetic OAuth codes are accepted');
      return { data: { code: 0, access_token: body.code } };
    },
    get: async (_url, options) => ({ data: { code: 0, data: options.headers.Authorization === 'Bearer fixture-admin' ? { open_id: 'ou_fixture_admin', name: '测试管理员' } : { open_id: 'ou_fixture_unmapped', name: '测试访客' } } }),
  } });
  const access = new UnifiedAccessService();
  const controller = new UnifiedAccessController(access, feishu);
  const guard = new UnifiedAccessGuard({ getAllAndOverride: key => key === GuestReadableMetadataKey, get: () => false }, access);
  const express = require('express');
  const app = express();
  const counts = {};
  app.use(express.json());
  app.use((req, _res, next) => { counts[req.method + ' ' + req.path] = (counts[req.method + ' ' + req.path] || 0) + 1; next(); });
  app.get('/api/access/session', (req, res) => res.json(controller.session(req, res)));
  app.post('/api/access/logout', (req, res) => res.json(controller.logout(req, res)));
  app.get('/api/access/feishu/authorize', (req, res) => {
    res.redirect(302, '/fixture/guest-callback');
  });
  app.get(['/fixture/guest-callback', '/fixture/admin-callback'], (req, res) => {
    const state = crypto.randomBytes(24).toString('base64url');
    const request = { ...req, headers: { ...req.headers, cookie: `vnet_feishu_oauth_state=${state}; vnet_feishu_oauth_return_to=%2Fnantong-base` } };
    controller.feishuCallback({ state, code: req.path.includes('admin') ? 'fixture-admin' : 'fixture-guest' }, request, res).catch(() => res.sendStatus(500));
  });
  app.get('/fixture/guest-expiring', async (req, res) => {
    const session = access.issueTrustedSession(await feishu.exchangeAuthorizationCode('fixture-guest'), Date.now() - ACCESS_SESSION_TTL_MS + 4000);
    res.cookie(access.cookieName, session.token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 4000 });
    res.redirect(302, '/nantong-base?feishu_auth=success');
  });
  app.get('/fixture/stats', (_req, res) => res.json({ counts, compileMs, pid: process.pid }));
  app.post('/fixture/shutdown', (_req, res) => { res.json({ stopping: true }); server.close(() => process.exit(0)); });
  app.use('/api', (req, res) => {
    const context = { getHandler: () => () => {}, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
    res.status(guard.canActivate(context) ? 200 : 403).json({ fixture: true });
  });
  app.use(express.static(output));
  app.use((_req, res) => res.type('html').send('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'));
  const server = app.listen(43215, '127.0.0.1', () => {
    fs.writeFileSync(path.join(output, 'fixture-runtime.json'), JSON.stringify({ compileMs, pid: process.pid, port: 43215 }));
    console.log('FEISHU_GUEST_FIXTURE_READY http://127.0.0.1:43215/nantong-base');
  });
}
