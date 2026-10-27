const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/inventory-stocktake-browser');
const output = path.resolve(
  root,
  process.argv
    .find((arg) => arg.startsWith('--output-dir='))
    ?.slice('--output-dir='.length) || 'output/inventory-stocktake-dev-check',
);
fs.mkdirSync(output, { recursive: true });
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  entry: path.join(fixture, 'entry.tsx'),
  target: 'web',
  output: {
    path: output,
    filename: 'app.js',
    cssFilename: 'app.css',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@lark-apaas/client-toolkit/logger$': path.join(fixture, 'api.ts'),
      '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': path.join(
        fixture,
        'api.ts',
      ),
      '@': path.join(root, 'client/src'),
      '@shared': path.join(root, 'shared'),
    },
  },
  module: {
    rules: [
      { test: /\.(svg|png|jpe?g|webp)$/, type: 'asset/resource' },
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
    process.exitCode = 1;
    compiler.close(() => {});
    return;
  }
  compiler.close(() => start());
});
function start() {
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
  const { InventoryStocktakeStore } = require(
    path.join(
      root,
      'server/modules/inventory-management/inventory-stocktake.store.ts',
    ),
  );
  const { InventoryStocktakeService } = require(
    path.join(
      root,
      'server/modules/inventory-management/inventory-stocktake.service.ts',
    ),
  );
  const { InventoryStocktakeGenerationService } = require(
    path.join(
      root,
      'server/modules/inventory-management/inventory-stocktake-generation.service.ts',
    ),
  );
  const store = new InventoryStocktakeStore(
    path.join(output, 'fixture-ledger.json'),
  );
  const names = [
    '空气开关',
    'LED 灯管',
    '绝缘手套',
    '不锈钢扎带',
    '过滤棉',
    '熔断器',
  ];
  const people = [
    {
      recordId: 'test-person-1',
      openId: 'ou_test_1',
      name: '测试陈工',
      employeeNo: 'T001',
      building: 'A楼',
      position: '运行工程师',
      specialty: '',
    },
    {
      recordId: 'test-person-2',
      openId: 'ou_test_2',
      name: '测试陈工',
      employeeNo: 'T002',
      building: 'B楼',
      position: '暖通工程师',
      specialty: '',
    },
  ];
  const inventory = ['A楼', 'B楼'].flatMap((building) =>
    Array.from({ length: building === 'A楼' ? 500 : process.argv.includes('--bulk-read-check') ? 445 : 1 }, (_, i) => ({
      recordId: `test-${building}-${i}`,
      sku: `TEST-${building}-${String(i).padStart(4, '0')}`,
      name: `${names[i % names.length]} ${String(i).padStart(3, '0')}`,
      specification: '测试规格 32A / 序列号',
      brand: '',
      primaryCategory: '',
      secondaryCategory: '',
      building,
      location:
        i % 3 === 0
          ? `A-315-${1 + (i % 9)}-1`
          : `A-3F-${i % 3 === 1 ? '315' : '316'}储藏间${String(1 + (i % 9)).padStart(2, '0')}-2F`,
      quantity: 12,
      minimumQuantity: 0,
      difference: 12,
      unit: '个',
      storageType: '库内',
      annualUsage: 0,
      value: 0,
      owners: [],
      lowStock: false,
      negativeStock: false,
      idle: true,
      pendingConfirmation: false,
    })),
  );
  let bulkReadSource;
  if (process.argv.includes('--bulk-read-check')) {
    const { InventoryWorkflowGateway } = require('../../server/modules/inventory-management/inventory-workflow.gateway.ts');
    const { InventoryStocktakeSource } = require('../../server/modules/inventory-management/inventory-stocktake.source.ts');
    const reads = [];
    process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID = 'synthetic-inventory-table';
    const gateway = new InventoryWorkflowGateway({ axiosRef: {
      get: async () => { throw new Error('Full table listing is forbidden in this fixture'); },
      post: async (_url, body) => {
        const fail = process.argv.includes('--bulk-read-fail-once') && reads.length === 2;
        reads.push({ requested: body.record_ids.length, failed: fail });
        fs.writeFileSync(path.join(output, 'bulk-reads.json'), JSON.stringify({ externalWrites: 0, reads }, null, 2));
        if (fail) throw { response: { status: 403 } };
        await new Promise(resolve => setTimeout(resolve, 1500));
        return { data: { code: 0, data: { records: body.record_ids.map(id => {
          const item = inventory.find(row => row.recordId === id);
          return { record_id: id, fields: { 楼栋: item.building, 物品类别号: item.sku, 剩余库存: item.quantity, 存放位置: item.location } };
        }) } } };
      },
    } });
    gateway.getTenantAccessToken = async () => 'synthetic-token';
    bulkReadSource = new InventoryStocktakeSource({}, gateway);
    bulkReadSource.config = async () => ({ appToken: 'synthetic-app', url: '' });
  }
  if (process.argv.includes('--bulk-slow')) {
    const template = inventory[0];
    inventory.push(
      ...Array.from({ length: 955 }, (_, i) => ({
        ...template,
        recordId: `test-H楼-${i}`,
        sku: `TEST-H楼-${String(i).padStart(4, '0')}`,
        name: `${names[i % names.length]} H${String(i).padStart(3, '0')}`,
        building: 'H楼',
        location: `H-315-${1 + (i % 9)}-1`,
      })),
    );
  }
  const source = {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      if (generationFault) {
        generationFault = false;
        throw Object.assign(new Error('fixture source timeout'), {
          code: 'ETIMEDOUT',
        });
      }
      return { items: inventory, movements: [] };
    },
    current: async (item) =>
      inventory.find((i) => i.recordId === item.recordId),
    currentMany: async (items) => {
      if (bulkReadSource) return bulkReadSource.currentMany(items);
      if (process.argv.includes('--bulk-slow'))
        await new Promise((resolve) => setTimeout(resolve, 30000));
      return items.map((item) =>
        inventory.find((i) => i.recordId === item.recordId),
      );
    },
  };
  // Representative persisted historical detail; confined to this test ledger.
  if (!store.read().sheets.some((sheet) => sheet.month === '2026-07')) {
    const {
      stocktakeFingerprint,
    } = require('../../server/modules/inventory-management/inventory-stocktake.rules.ts');
    const inventoryItem = inventory[0],
      recordedAt = '2026-07-20T01:00:00.000Z';
    store.mutate('fixture-history-july', 'fixture-history-july', (state) => {
      state.historyStartedAt ||= '2026-07-01T01:00:00.000Z';
      state.sheets.push({
        month: '2026-07',
        building: 'A楼',
        status: 'completed',
        version: 2,
        createdAt: recordedAt,
        completedAt: recordedAt,
        historyStartedAt: state.historyStartedAt,
        seed: 'fixture-history-july',
        algorithm: 'sha256-rank-v1',
        inventoryCount: 500,
        randomTarget: 1,
        shortfall: 0,
        excludedRecordIds: [],
        lines: [
          {
            inventory: inventoryItem,
            reasons: ['random'],
            movementIds: [],
            stockFingerprint: stocktakeFingerprint(inventoryItem),
            version: 2,
            status: 'confirmed',
            updatedAt: recordedAt,
            confirmedAt: recordedAt,
            operatorFingerprint: 'fixture-session',
            actualQuantity: 12,
            confirmer: people[0],
            note: '',
          },
        ],
      });
      return true;
    });
  }
  const service = new InventoryStocktakeService(store, source, {
    resolveApplicantForBuilding: async (person) =>
      people.find(
        (p) =>
          p.recordId === person.recordId &&
          p.openId === person.openId &&
          p.building === person.building,
      ) || null,
  });
  const principal = { role: 'admin', purchaseBuilding: null };
  const {
    InventoryStocktakeBulkService,
  } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service.ts');
  const bulk = new InventoryStocktakeBulkService(store, service);
  bulk.onModuleInit();
  const generation = new InventoryStocktakeGenerationService(
    store,
    source,
    service,
  );
  const {
    InventoryStocktakeResultsSync,
  } = require('../../server/modules/inventory-management/inventory-stocktake-results.sync.ts');
  const remoteRecords = new Map();
  let syncFault = process.argv.includes('--sync-fail-once');
  const resultsSync = new InventoryStocktakeResultsSync(store, {
    ensureSchema: async () => {},
    index: async () => new Map(remoteRecords),
    create: async (ids) =>
      ids.forEach((id) => remoteRecords.set(id, `fixture-remote-${id}`)),
    update: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (syncFault) {
        syncFault = false;
        throw new Error('测试飞书同步失败，请重试');
      }
    },
  });
  let generationFault = process.argv.includes('--generation-fail-once');
  let writeCount = 0;
  const faults = new Set();
  const searchOrder = [];
  const monthOrder = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(data === null ? undefined : JSON.stringify(data));
    };
    try {
      if (url.pathname === '/assets/vnet-official-logo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(
          fs.readFileSync(
            path.join(root, 'client/public/assets/vnet-official-logo.png'),
          ),
        );
      }
      if (url.pathname === '/api/access/session')
        return send({
          role: 'admin',
          purchaseBuilding: null,
          principalFingerprint: 'fixture-admin-session',
          expiresAt: Date.now() + 3600000,
        });
      if (url.pathname === '/api/inventory-management/dashboard') {
        const {
          buildInventoryManagementSnapshot,
        } = require('../../server/modules/inventory-management/inventory-management.mapper.ts');
        const snapshot = buildInventoryManagementSnapshot({
          inventory: inventory.map((i) => ({
            record_id: i.recordId,
            fields: {
              楼栋: i.building,
              物品类别号: i.sku,
              名称: i.name,
              剩余库存: i.quantity,
              存放位置: i.location,
            },
          })),
          catalog: [],
          inbound: [],
          outbound: [],
          borrow: [],
          prices: [],
          stocktakeSummaries: [
            {
              record_id: 'history-sep-a',
              fields: {
                楼栋: 'A楼',
                日期: '2026-09-01T00:00:00+08:00',
                盘点月份: 9,
                盘点总数: 20,
                已盘点数量: 20,
                责任人: '测试陈工',
              },
            },
            {
              record_id: 'history-sep-b',
              fields: {
                楼栋: 'B楼',
                日期: '2026-09-01T00:00:00+08:00',
                盘点月份: 9,
                盘点总数: 20,
                已盘点数量: 20,
                责任人: '测试王工',
              },
            },
            {
              record_id: 'history-aug',
              fields: {
                楼栋: 'A楼',
                日期: '2026-08-01T00:00:00+08:00',
                盘点月份: 8,
                盘点总数: 20,
                已盘点数量: 10,
                责任人: '测试陈工',
              },
            },
          ],
          managers: [],
          sourceUrl: '',
          generatedAt: new Date().toISOString(),
          sectionStatus: Object.fromEntries(
            [
              'inventory',
              'catalog',
              'inbound',
              'outbound',
              'borrow',
              'prices',
              'stocktake',
              'managers',
            ].map((k) => [k, { configured: true, count: 0 }]),
          ),
        });
        return send(snapshot.dashboard);
      }
      if (url.pathname === '/api/purchase-inventory/applicant-search') {
        const q = url.searchParams.get('query') || '';
        const matches = people.filter((p) =>
          `${p.name} ${p.employeeNo}`.includes(q),
        );
        searchOrder.push({ query: q, event: 'request' });
        return setTimeout(
          () => {
            searchOrder.push({ query: q, event: 'response' });
            fs.writeFileSync(
              path.join(output, 'search-order.json'),
              JSON.stringify(searchOrder, null, 2),
            );
            send(matches);
          },
          q === '陈' ? 1200 : 50,
        );
      }
      if (url.pathname.startsWith('/api/inventory-management/stocktake/')) {
        const action = url.pathname.split('/').at(-1);
        let body = '';
        for await (const chunk of req) body += chunk;
        const input = body ? JSON.parse(body) : {},
          month = url.searchParams.get('month'),
          building = url.searchParams.get('building');
        if (req.method === 'GET') {
          if (action === 'bulk-status')
            return send(
              bulk.status(
                month,
                building,
                url.searchParams.get('id'),
                principal,
              ),
            );
          if (action === 'sync-status')
            return send(
              resultsSync.summary(
                month,
                building,
                url.searchParams.get('scope') || 'sample',
              ),
            );
          const value =
            action === 'overview'
              ? {
                  ...service.overview(month, principal),
                  generation: generation.status(month, principal),
                }
              : service.get(
                  month,
                  building,
                  principal,
                  url.searchParams.get('scope') || undefined,
                );
          monthOrder.push({ action, month, event: 'request' });
          const fail =
            action === 'overview' &&
            month === '2026-08' &&
            !faults.has('month-aug');
          if (fail) faults.add('month-aug');
          return setTimeout(
            () => {
              monthOrder.push({
                action,
                month,
                event: 'response',
                status: fail ? 503 : 200,
              });
              fs.writeFileSync(
                path.join(output, 'month-order.json'),
                JSON.stringify(monthOrder, null, 2),
              );
              send(
                fail ? { message: '测试月份读取失败' } : value,
                fail ? 503 : 200,
              );
            },
            month === '2026-09' ? 1200 : 50,
          );
        }
        writeCount++;
        if (action === 'retry-sync')
          return send(
            service.retrySync(input, principal, 'fixture-session', resultsSync),
            202,
          );
        if (action === 'generate') {
          const accepted = generation.request(
            input,
            principal,
            'fixture-session',
          );
          send(accepted, 202);
          fs.writeFileSync(
            path.join(output, 'generation-requests.json'),
            JSON.stringify(
              {
                writeCount,
                id: accepted.id,
                month: accepted.month,
                accepted: true,
                externalWrites: 0,
              },
              null,
              2,
            ),
          );
          void generation
            .runPending()
            .catch((error) => console.error(error.message));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (
          input.note === '测试失败重试' &&
          !faults.has(input.clientMutationId)
        ) {
          faults.add(input.clientMutationId);
          return send({ message: '测试服务暂时不可用，请重试' }, 503);
        }
        const result =
          action === 'start'
            ? await service.start(input, principal, 'fixture-session')
            : action === 'bulk-confirm'
              ? bulk.request(input, principal, 'fixture-session')
              : action === 'bulk-undo'
                ? service.undoReview(input, principal, 'fixture-session')
                : action === 'complete'
                  ? await service.complete(input, principal, 'fixture-session')
                  : await service.writeLine(
                      input,
                      principal,
                      'fixture-session',
                      action === 'refresh-line' ? 'refresh' : action,
                    );
        resultsSync.kick();
        fs.writeFileSync(
          path.join(output, 'request-summary.json'),
          JSON.stringify(
            { writeCount, lastAction: action, realExternalRequests: 0 },
            null,
            2,
          ),
        );
        if (
          input.note === '测试超时重试' &&
          !faults.has(input.clientMutationId)
        ) {
          faults.add(input.clientMutationId);
          return setTimeout(() => send(result), 500);
        }
        return send(result, action === 'bulk-confirm' ? 202 : 200);
      }
      if (url.pathname === '/' || url.pathname === '/inventory-management') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>盘点开发验收</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>',
        );
      }
      const file =
        url.pathname === '/app.js'
          ? 'app.js'
          : url.pathname === '/app.css'
            ? 'app.css'
            : /^[a-zA-Z0-9_.-]+\.(js|css|svg|png|jpe?g|webp)$/.test(
                  url.pathname.slice(1),
                )
              ? url.pathname.slice(1)
              : null;
      if (!file) return send({ message: 'not found' }, 404);
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js')
          ? 'application/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream',
      });
      res.end(fs.readFileSync(path.join(output, file)));
    } catch (error) {
      send(
        { message: error.message },
        typeof error.getStatus === 'function' ? error.getStatus() : 500,
      );
    }
  });
  server.listen(0, '127.0.0.1', () =>
    console.log(`STOCKTAKE_DEV_URL=http://127.0.0.1:${server.address().port}/`),
  );
}
