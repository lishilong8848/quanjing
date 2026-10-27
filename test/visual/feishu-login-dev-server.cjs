const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/feishu-login-browser');
const output = path.join(root, 'output/feishu-login-check/browser');
const mocks = path.join(fixture, 'api.ts');
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(fixture, 'entry.tsx'),
  output: {
    path: output,
    filename: 'app.js',
    cssFilename: 'app.css',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@/api$': mocks,
      '@': path.join(root, 'client/src'),
      '@shared': path.join(root, 'shared'),
      '@lark-apaas/client-toolkit/logger$': mocks,
      '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': mocks,
      '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$': mocks,
      '@lark-apaas/client-toolkit/dataloom$': mocks,
    },
  },
  module: {
    rules: [
      { test: /\.svg$/, type: 'asset/inline' },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2022',
            },
          },
        },
      },
      {
        test: /\.css$/,
        type: 'css/auto',
        use: {
          loader: 'postcss-loader',
          options: {
            postcssOptions: { plugins: { '@tailwindcss/postcss': {} } },
          },
        },
      },
    ],
  },
  experiments: { css: true },
  plugins: [
    new (require('@rspack/core').DefinePlugin)({
      'process.env.CLIENT_BASE_PATH': JSON.stringify(''),
    }),
  ],
});
if (
  process.argv.includes('--reuse-client') &&
  fs.existsSync(path.join(output, 'app.js'))
)
  start();
else
  compiler.run((error, stats) => {
    if (error || stats.hasErrors()) {
      console.error(error || stats.toString({ all: false, errors: true }));
      compiler.close(() => {});
      process.exitCode = 1;
    } else compiler.close(start);
  });
function start() {
  require('reflect-metadata');
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
      module: 'CommonJS',
      moduleResolution: 'node',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  });
  require('tsconfig-paths').register({
    baseUrl: root,
    paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] },
  });
  const {
    FeishuAccessService,
  } = require('../../server/common/access/feishu-access.service');
  const {
    UnifiedAccessService,
  } = require('../../server/common/access/unified-access.service');
  const {
    UnifiedAccessController,
  } = require('../../server/common/access/unified-access.controller');
  const env = {};
  for (const name of ['.env', '.env.local'])
    if (fs.existsSync(path.join(root, name)))
      Object.assign(
        env,
        require('dotenv').parse(fs.readFileSync(path.join(root, name))),
      );
  process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
  process.env.LOCAL_ACCESS_SESSION_SECRET = require('node:crypto')
    .randomBytes(32)
    .toString('base64');
  const adminIds = String(env.FEISHU_ACCESS_ADMIN_OPEN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (adminIds.length !== 3)
    throw new Error('The fixture requires three configured administrators');
  const [adminId] = adminIds;
  const fixtureIdentities = Object.entries(env)
    .filter(([key]) =>
      /^FEISHU_ACCESS_(ADMIN|EDITOR|PURCHASE_ADMIN|BUILDING_ADMIN_[ABCDEH]|INVENTORY_ADMIN_[ABCDEH])_OPEN_IDS$/.test(
        key,
      ),
    )
    .flatMap(([, value]) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  const fixtureConfig = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('FEISHU_ACCESS_')),
  );
  const feishu = new FeishuAccessService(
    { get: (key) => fixtureConfig[key] },
    {
      axiosRef: {
        async post(_url, body) {
          const match = /^fixture-only-code-(\d+)$/.exec(body.code);
          if (!match || Number(match[1]) >= fixtureIdentities.length)
            throw new Error('Fixture rejects real authorization codes');
          return {
            data: { code: 0, access_token: 'fixture-only-token-' + match[1] },
          };
        },
        async get(_url, options) {
          const match = /^Bearer fixture-only-token-(\d+)$/.exec(
            options.headers.Authorization,
          );
          if (!match) throw new Error('Invalid fixture-only token');
          return {
            data: {
              code: 0,
              data: { open_id: fixtureIdentities[Number(match[1])],
                name: Number(match[1]) === 0 ? '马进宇' : '测试长姓名'.repeat(24) },
            },
          };
        },
      },
    },
  );
  if (feishu.resolvePrincipal(adminId)?.role !== 'admin')
    throw new Error('Confirmed administrator mapping is missing');
  const access = new UnifiedAccessService();
  const controller = new UnifiedAccessController(access, feishu);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.get('/api/access/session', (req, res) =>
    res.json(controller.session(req, res)),
  );
  app.post('/api/access/logout', (req, res) =>
    res.json(controller.logout(req, res)),
  );
  app.get('/api/access/feishu/authorize', (req, res) =>
    controller.feishuAuthorize(req.query.returnTo, req, res),
  );
  app.get('/api/access/feishu/callback', (req, res) =>
    controller
      .feishuCallback(req.query, req, res)
      .catch(() => res.sendStatus(500)),
  );
  app.get('/fixture/identities', (_req, res) => {
    const links = fixtureIdentities.map((id, index) => {
      const principal = feishu.resolvePrincipal(id);
      if (!principal) throw new Error('Fixture identity has no approved grant');
      return `<li><a href="/fixture/identity/${index}">${principal.role} ${principal.purchaseBuilding || ''} (${index})</a></li>`;
    });
    res
      .type('html')
      .send(
        `<meta charset="utf-8"><h1>授权身份隔离验收</h1><ul>${links.join('')}</ul>`,
      );
  });
  app.get(
    ['/fixture/admin-callback', '/fixture/identity/:index'],
    (req, res) => {
      const index =
        req.params.index === undefined ? 0 : Number(req.params.index);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= fixtureIdentities.length
      )
        return res.sendStatus(400);
      const state = require('node:crypto')
        .randomBytes(32)
        .toString('base64url');
      const callbackRequest = {
        ...req,
        headers: {
          ...req.headers,
          cookie: `vnet_feishu_oauth_state=${state}; vnet_feishu_oauth_return_to=%2Fmonthly-schedule`,
        },
      };
      controller
        .feishuCallback(
          { state, code: 'fixture-only-code-' + index },
          callbackRequest,
          res,
        )
        .catch(() => res.sendStatus(500));
    },
  );
  app.use(express.static(output));
  app.use(express.static(path.join(root, 'client/public')));
  app.use((_req, res) =>
    res
      .type('html')
      .send(
        '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      ),
  );
  const server = http.createServer(app);
  server.listen(43211, '127.0.0.1', () =>
    console.log(
      'FEISHU_LOGIN_FIXTURE_READY http://127.0.0.1:43211/monthly-schedule',
    ),
  );
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
