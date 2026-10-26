const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/equipment-ledger-browser');
const output = path.join(
  root,
  'output/equipment-repair-metrics-20261003-check/browser',
);
fs.mkdirSync(output, { recursive: true });
const started = Date.now();
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(fixture, 'workspace-entry.tsx'),
  output: {
    path: output,
    filename: 'app.js',
    cssFilename: 'app.css',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      './Layout$': path.join(fixture, 'navigation-layout.tsx'),
      '@/access/AccessProvider$': path.join(fixture, 'permission-access.tsx'),
      '@': path.join(root, 'client/src'),
      '@shared': path.join(root, 'shared'),
      '@lark-apaas/client-toolkit/logger$': path.join(fixture, 'api.ts'),
      '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': path.join(
        fixture,
        'api.ts',
      ),
    },
  },
  module: {
    rules: [
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
});
compiler.run((error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    compiler.close(() => {});
    process.exitCode = 1;
    return;
  }
  compiler.close(start);
});
async function start() {
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
    paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
  });
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const read = (file) =>
    JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const identities = read(
    'output/equipment-history-card-planning/full-audit-2026-10-02/ledger.json',
  ).records;
  const aliases = new Map(
    identities.map((r) => [r.id || r.record_id, r.fields['楼栋标识']]),
  );
  const source = read(
    'data/feishu-bitable-cache/1cffe0c0c62e1e79908edd3ec2b2bf56720fe0f9.json',
  );
  // Real local exports joined by stable record ID; lifecycle rows are representative fixtures.
  const rows = source.records.map((r) => ({
    ...r,
    fields: { ...r.fields, 楼栋标识: aliases.get(r.id || r.record_id) },
  }));
  const repairs = read(
    'output/equipment-history-check/live-repair-source.json',
  ).records;
  const helpers = require('../../server/common/feishu/bitable-direct-read');
  helpers.resolveBitableAppToken = async () => 'fixture';
  helpers.fetchBitableRecords = async () => rows;
  const reader = require('../../server/modules/equipment-lifecycle/equipment-repair-source.reader');
  reader.readPersistedRepairSnapshot = async () => ({
    records: repairs,
    fetchedAt: Date.now(),
  });
  reader.fetchEquipmentRepairRecords = async () => repairs;
  reader.persistRepairSnapshot = async () => {};
  const {
    mapEquipmentLifecycleDashboard,
  } = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.mapper');
  const lifeRows = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].flatMap((building, i) =>
    Array.from({ length: 12 }, (_, j) => ({
      record_id: `${i}-${j}`,
      fields: {
        楼栋: building,
        设备名称: ['柴发', 'UPS', 'HVDC', '冷水机组'][j % 4],
        状态: j % 3 ? '未到期' : '过期',
        合同当前状态: j % 3 ? '在保' : '过保',
        安装日期: '2020-06-01',
        寿命到期时间: '2027-06-01',
        维保截止日期: '2027-06-01',
        管理员: '验收人员',
        已使用年数: 6,
        寿命年限: 15,
        本次到期日期: `2026-${String(j + 1).padStart(2, '0')}-15`,
      },
    })),
  );
  const lifecycle = {
    getDashboard: async (_refresh, building) =>
      mapEquipmentLifecycleDashboard(
        Object.fromEntries(
          [
            'equipment',
            'keyParts',
            'longTermMaintenance',
            'maintenanceContracts',
          ].map((k) => [k, { status: 'fresh', records: lifeRows.map((record, index) => ({ ...record, fields: { ...record.fields, 状态: k === 'equipment' ? index % 3 ? '未到期' : '待评估' : k === 'longTermMaintenance' ? index % 3 ? '在保' : '到期' : ['在保', '三月预警', '过保'][index % 3] } })) }]),
        ),
        { month: '2026-10', syncedAt: new Date().toISOString(), building },
      ),
  };
  const {
    EquipmentLedgerService,
  } = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
  const {
    EquipmentRepairSourceService,
  } = require('../../server/modules/equipment-lifecycle/equipment-repair-source.service');
  const {
    EquipmentHistoryService,
  } = require('../../server/modules/equipment-lifecycle/equipment-history.service');
  const {
    EquipmentLedgerController,
  } = require('../../server/modules/equipment-lifecycle/equipment-ledger.controller');
  const ledger = new EquipmentLedgerService({}, lifecycle);
  ledger.snapshot = ledger.build(rows, Date.now(), false);
  const history = new EquipmentHistoryService(
    ledger,
    new EquipmentRepairSourceService({}),
  );
  const controller = new EquipmentLedgerController(ledger, history);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:43195');
    const json = (value, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/fixture-diagnostics')
      return json({ rows: rows.length, requests });
    if (url.pathname.startsWith('/api/equipment-ledger/')) {
      const query = Object.fromEntries(url.searchParams);
      const identity = decodeURIComponent(
        req.headers['x-fixture-principal'] || 'admin',
      );
      const request = {
        accessPrincipal: {
          role: ['admin', 'editor', 'guest'].includes(identity)
            ? identity
            : 'building_admin',
          purchaseBuilding: identity === 'station' ? '110站' : identity,
        },
      };
      requests.push({ route: url.pathname, query, identity, at: Date.now() });
      try {
        if (query.__case === 'error')
          return json({ message: '设备读取失败，请重试' }, 503);
        const route = url.pathname.split('/').pop();
        let value;
        if (route === 'dashboard')
          value = await controller.getDashboard(
            request,
            query.refresh,
            query.async,
          );
        else if (route === 'items')
          value = await controller.getItems(request, query);
        else if (route === 'history-devices')
          value = await controller.getHistoryDevices(request, query.refresh);
        else if (route === 'history')
          value = await controller.getHistory(
            request,
            query.assetId,
            query.refresh,
          );
        else if (route === 'lifecycle-dashboard')
          value = await controller.getLifecycleDashboard(
            request,
            query.building,
            query.refresh,
          );
        else if (route === 'lifecycle')
          value = await controller.getLifecycle(request);
        else return json({ message: '不存在' }, 404);
        if (query.__case === 'stale')
          value = { ...value, stale: true, error: '更新失败，请重试' };
        if (query.__case === 'timeout' || query.__case === 'late')
          return setTimeout(() => json(value), 600);
        return json(value);
      } catch (error) {
        return json({ message: error.message }, error.getStatus?.() || 500);
      }
    }
    const name = url.pathname.slice(1);
    if (
      name &&
      /^[\w.-]+\.(?:js|css)$/u.test(name) &&
      fs.existsSync(path.join(output, name))
    ) {
      res.setHeader(
        'Content-Type',
        name.endsWith('.css') ? 'text/css' : 'text/javascript',
      );
      return res.end(fs.readFileSync(path.join(output, name)));
    }
    if (url.pathname === '/assets/vnet-official-logo.png') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(
        fs.readFileSync(
          path.join(root, 'client/public/assets/vnet-official-logo.png'),
        ),
      );
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><html lang="zh-CN" data-ledger-source="snapshot"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备资产开发验收</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>',
    );
  });
  server.listen(43195, '127.0.0.1', () =>
    console.log(
      `WORKSPACE_BROWSER_READY port=43195 rows=${rows.length} repairs=${repairs.length} developmentMs=${Date.now() - started}`,
    ),
  );
  const close = () => {
    fs.writeFileSync(
      path.join(output, 'network-evidence.json'),
      JSON.stringify(requests, null, 2),
    );
    server.close(() => process.exit());
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
