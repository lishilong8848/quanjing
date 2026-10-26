const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/equipment-ledger-browser');
const permissions = process.argv[2] === 'permissions';
const revision3 = process.argv[2] === 'revision-3' || permissions;
const output = path.join(
  root,
  permissions ? 'output/equipment-ledger-permissions-check' : `output/equipment-ledger-revision-${revision3 ? '3' : '2'}-check`,
);
fs.mkdirSync(output, { recursive: true });
const started = Date.now();
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(fixture, permissions ? 'permissions-entry.tsx' : 'entry.tsx'),
  output: {
    path: output,
    filename: 'app.js',
    cssFilename: 'app.css',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      ...(permissions ? { '@/access/AccessProvider$': path.join(fixture, 'permission-access.tsx') } : {}),
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
  const {
    mapLedgerRecords,
    summarizeLedger,
    queryLedger,
  } = require('../../server/modules/equipment-lifecycle/equipment-ledger.model');
  const asOf = '2026-10-01';
  let fixtureSnapshotId = 'fixture-40000';
  let fixtureUpdatedAt = '2026-10-01T05:00:00Z';
  let rows = Array.from({ length: 40000 }, (_, i) => ({
    record_id: `test-${i}`,
    fields: {
      编号: `TEST-${i}`,
      设备编号: i % 503 === 0 ? '全部测试设备' : `测试-${i}`,
      机楼: `${String.fromCharCode(65 + (i % 5))}楼`,
      设备名称: [
        '冷水机组',
        'UPS电源',
        '低压配电柜',
        '精密空调',
        '蓄电池',
        '柴油发电机',
        '交换机',
        '消防探测器',
      ][i % 8],
      大设备类型: ['暖通设备', '电源设备', '配电设备', '制冷设备'][i % 4],
      系统名称: ['暖通', '配电', '弱电', '消防'][i % 4],
      品牌: ['测试品牌A', '测试品牌B', '测试品牌C'][i % 3],
      型号: i % 5 ? `M-${i % 19}/型号${i % 4}` : '',
      数量: 1,
      安装日期: '2020-06-01',
      维保截止日期:
        i % 3 === 0 ? '2025-07-01' : i % 3 === 1 ? '2027-06-01' : '',
      质保年限来源: i % 17 === 0 ? '参考推定' : '原台账',
      '质保期（年）': 5,
      安装位置: `${1 + (i % 8)}层/测试机房${i % 20}`,
      '序列号/出厂编号': `SNTEST${i}`,
      产品其它参数: i % 7 === 0 ? '测试参数长文本 '.repeat(80) : '',
    },
  }));
  if (revision3) {
    const {
      readLatestPersistedBitableRecordSnapshot,
    } = require('../../server/common/feishu/bitable-direct-read');
    const {
      EQUIPMENT_LEDGER_FIELDS,
    } = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
    const snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c',
      tableId: 'tbld39d3db603982',
      tableName: '南通各机楼设备台账',
      fieldNames: EQUIPMENT_LEDGER_FIELDS,
    });
    if (!snapshot) throw new Error('Verified local ledger snapshot missing');
    rows = snapshot.records;
    fixtureSnapshotId = require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify({ records: rows, asOf }))
      .digest('hex');
    fixtureUpdatedAt = new Date(snapshot.fetchedAt).toISOString();
  }
  const assets = mapLedgerRecords(rows, asOf);
  const dashboard = {
    snapshotId: fixtureSnapshotId,
    updatedAt: fixtureUpdatedAt,
    asOf,
    stale: false,
    overview: summarizeLedger(assets),
    buildings: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((building) =>
      summarizeLedger(assets, building),
    ),
  };
  const lifecycle = {
    status: 'fresh',
    assets: [
      {
        id: 'life1',
        building: 'A楼',
        name: '冷水机组',
        status: '未到期',
        dueDate: '2027-12-01',
      },
    ],
    maintenanceContracts: [
      {
        id: 'contract1',
        building: 'A楼',
        name: '测试冷机维保合同',
        status: '在保',
        dueDate: '2027-06-01',
      },
    ],
    longTermMaintenance: [],
    keyParts: [],
  };
  const requests = [];
  const { ledgerAccessBuilding, scopeLedgerDashboard, scopeLedgerQuery, scopeLedgerLifecycle, scopedLedgerSnapshotId } = require('../../server/modules/equipment-lifecycle/equipment-ledger-access');
  const coldStarted = new Map();
  let openResponses = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:43191');
    if (url.pathname.startsWith('/api/equipment-ledger/')) {
      const query = Object.fromEntries(url.searchParams);
      const identity = decodeURIComponent(req.headers['x-fixture-principal'] || 'admin');
      let building = null;
      try {
        if (permissions) building = ledgerAccessBuilding({ role: ['admin', 'editor', 'guest'].includes(identity) ? identity : 'building_admin', purchaseBuilding: identity === 'station' ? '110站' : ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].includes(identity) ? identity : null });
        if (permissions && url.pathname.endsWith('/items')) Object.assign(query, scopeLedgerQuery(query, building));
      } catch {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: '无设备台账访问权限' }));
        return;
      }
      const scopedDashboard = permissions ? scopeLedgerDashboard(dashboard, building) : dashboard;
      requests.push({ path: url.pathname, query, identity, at: Date.now() });
      const send = () => {
        --openResponses;
        if (res.destroyed) return;
        res.setHeader('Content-Type', 'application/json');
        if (query.__case === 'error') {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: '测试读取失败' }));
          return;
        }
        const stale = query.__case === 'stale';
        if (url.pathname.endsWith('/dashboard')) {
          const mode = query.__case;
          if (query.async === '1') {
            if (['cold', 'hang', 'cold-error'].includes(mode)) {
              if (query.refresh === '1' || !coldStarted.has(mode))
                coldStarted.set(mode, Date.now());
              const elapsed = Date.now() - coldStarted.get(mode);
              if (mode === 'cold-error' && elapsed > 600) {
                res.end(
                  JSON.stringify({
                    status: 'error',
                    dashboard: null,
                    refreshing: false,
                    error: '设备台账读取失败，请重试',
                  }),
                );
                return;
              }
              if (mode === 'hang' || elapsed < 1800) {
                res.end(
                  JSON.stringify({
                    status: 'loading',
                    dashboard: null,
                    refreshing: true,
                    error: '',
                  }),
                );
                return;
              }
            }
            res.end(
              JSON.stringify({
                status: 'ready',
                dashboard: { ...scopedDashboard, stale },
                refreshing: false,
                error: '',
              }),
            );
          } else res.end(JSON.stringify({ ...scopedDashboard, stale }));
        } else if (url.pathname.endsWith('/lifecycle'))
          res.end(JSON.stringify(permissions ? scopeLedgerLifecycle(lifecycle, building) : lifecycle));
        else
          res.end(
            JSON.stringify({
              ...queryLedger(assets, query),
              snapshotId: scopedLedgerSnapshotId(dashboard.snapshotId, building),
              updatedAt: dashboard.updatedAt,
              asOf,
              stale,
            }),
          );
      };
      ++openResponses;
      const delay =
        query.__case === 'timeout'
          ? 600
          : query.__case === 'late' && String(query.search).includes('旧查询')
            ? 1000
            : 30;
      setTimeout(send, delay);
      return;
    }
    if (url.pathname === '/fixture-diagnostics') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ rows: rows.length, openResponses, requests }));
      return;
    }
    const file =
      url.pathname === '/app.js'
        ? 'app.js'
        : url.pathname === '/app.css'
          ? 'app.css'
          : url.pathname === '/assets/vnet-official-logo.png'
            ? 'logo'
            : null;
    if (file) {
      res.setHeader(
        'Content-Type',
        file === 'app.js'
          ? 'text/javascript'
          : file === 'app.css'
            ? 'text/css'
            : 'image/png',
      );
      let bytes = fs.readFileSync(
        file === 'logo'
          ? path.join(root, 'client/public/assets/vnet-official-logo.png')
          : path.join(output, file),
      );
      if (file === 'app.css' && url.searchParams.get('missingBase') === '1')
        bytes = Buffer.from(
          bytes
            .toString('utf8')
            .replace(/\.equipment-ledger-page\s*\{[^}]*\}/u, ''),
        );
      res.end(bytes);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><html lang="zh-CN" data-ledger-source="${revision3 ? 'snapshot' : 'representative'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备台账开发验收</title><link rel="stylesheet" href="/app.css${url.searchParams.get('missingBase') === '1' ? '?missingBase=1' : ''}"><div id="root"></div><script src="/app.js"></script></html>`,
    );
  });
  server.listen(43191, '127.0.0.1', () =>
    console.log(
      `LEDGER_FIXTURE_READY port=43191 rows=${rows.length} developmentMs=${Date.now() - started}`,
    ),
  );
  const close = () => {
    fs.writeFileSync(
      path.join(output, 'browser-network-evidence.json'),
      JSON.stringify({ rows: rows.length, requests, openResponses }, null, 2),
    );
    server.close(() => process.exit());
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
