const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(
  root,
  'test/fixtures/inventory-movement-specialty-browser',
);
const output = path.join(
  root,
  'output/inventory-movement-specialty-regression-check/browser',
);
const port = 5198;
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
    return compiler.close(() => {});
  }
  compiler.close(start);
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
  const {
    buildMovementOptions,
  } = require('../../server/modules/inventory-management/inventory-movement-command.rules');
  const tasks = new Map();
  const requests = [];
  const evidence = () =>
    fs.writeFileSync(
      path.join(output, 'requests.json'),
      JSON.stringify(
        { externalWrites: 0, requests, tasks: [...tasks.values()] },
        null,
        2,
      ),
    );
  function options(type, building) {
    const sku = building === 'D楼' ? 'D1002' : 'A1118';
    return buildMovementOptions({
      type,
      building,
      catalog: [
        {
          record_id: `catalog-${building}`,
          fields: {
            物品类别号: sku,
            名称: building === 'D楼' ? '测试日光灯管' : '测试直流监控主机',
            楼栋: building,
            专业: '电气',
            '规格型号、设备序列号': '回归测试型号',
            一级分类: '备品备件',
            二级分类: '电气备件',
            计数单位: '个',
          },
        },
      ],
      inventory: [
        {
          record_id: `inventory-${building}`,
          fields: {
            物品类别号: sku,
            楼栋: building,
            剩余库存: 49,
            存放位置: `${building}-315-01`,
          },
        },
      ],
    });
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === '/api/access/session')
        return send({
          role: 'admin',
          purchaseBuilding: null,
          principalFingerprint: 'A'.repeat(43),
          expiresAt: Date.now() + 3600000,
        });
      if (url.pathname === '/api/page-permissions') return send({});
      if (url.pathname === '/api/purchase-inventory/applicant-search')
        return send([
          {
            recordId: 'test-person',
            openId: 'ou_synthetic_person',
            name: '测试陶工',
            employeeNo: 'TEST001',
            position: '运维工程师',
            building: 'D楼',
            specialty: '电气',
          },
        ]);
      if (url.pathname === '/api/inventory-management/movement-options')
        return send(
          options(
            url.searchParams.get('type'),
            url.searchParams.get('building'),
          ),
        );
      if (url.pathname === '/api/inventory-management/storage-locations')
        return send([]);
      if (
        url.pathname === '/api/inventory-management/purchase-inbounds/pending'
      )
        return send({
          items: [],
          total: 0,
          generatedAt: new Date().toISOString(),
        });
      if (
        req.method === 'POST' &&
        [
          '/api/inventory-management/movements',
          '/api/inventory-management/outbounds',
        ].includes(url.pathname)
      ) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push({ path: url.pathname, input, at: Date.now() });
        let task = tasks.get(input.clientMutationId);
        if (!task) {
          const option = options(input.type, input.building)[0];
          const movement = {
            specialty: option.specialty,
            recordId: `test-${input.clientMutationId}`,
            clientMutationId: input.clientMutationId,
            type: input.type,
            sku: option.sku,
            name: option.name,
            specification: option.specification,
            quantity: input.quantity,
            unit: option.unit,
            building: input.building,
            destinationBuilding: '',
            location: option.location,
            reason: input.reason || '',
            operator: '测试操作人',
            applicant: input.type === 'outbound' ? '测试陶工' : '',
            status: input.type === 'outbound' ? '待库房确认' : '已入库',
            occurredAt: input.occurredAt,
            expectedReturnAt: null,
            overdue: false,
          };
          task = {
            id: input.clientMutationId,
            kind: 'manual',
            status: 'running',
            message: '测试后台处理中',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            input,
            result: {
              success: true,
              recordId: movement.recordId,
              type: input.type,
              alreadyProcessed: false,
              message: '测试处理完成',
              movement,
            },
            polls: 0,
          };
          tasks.set(input.clientMutationId, task);
        }
        evidence();
        return send(
          {
            accepted: true,
            taskId: task.id,
            kind: 'manual',
            status: task.status,
            message: '后台处理中',
          },
          202,
        );
      }
      if (
        /\/api\/inventory-management\/(inbounds|outbounds)\/tasks\//.test(
          url.pathname,
        )
      ) {
        const task = tasks.get(
          decodeURIComponent(url.pathname.split('/').pop()),
        );
        if (!task) return send({ message: '任务不存在' }, 404);
        task.polls += 1;
        // A refresh can observe the same durable task without submitting a second request.
        if (task.polls >= 4) {
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
        }
        evidence();
        return send({ success: true, task });
      }
      if (url.pathname === '/api/inventory-management/movements') {
        const items = [...tasks.values()]
          .filter(
            (task) =>
              task.status === 'completed' &&
              task.input.type === url.searchParams.get('type'),
          )
          .map((task) => task.result.movement);
        return send({
          items,
          total: items.length,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          summary: {
            totalRecords: items.length,
            totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
            overdueItems: 0,
            statusCounts: [],
          },
        });
      }
      if (url.pathname.startsWith('/api/'))
        return send({ message: `测试夹具尚未配置 ${url.pathname}` }, 404);
      if (url.pathname === '/app.js' || url.pathname === '/app.css') {
        res.writeHead(200, {
          'Content-Type': url.pathname.endsWith('css')
            ? 'text/css'
            : 'text/javascript',
        });
        return res.end(
          fs.readFileSync(path.join(output, url.pathname.slice(1))),
        );
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>出入库回归测试</title><div id="root"></div><script src="/app.js"></script></html>',
      );
    } catch (error) {
      console.error(error);
      send({ message: String(error) }, 500);
    }
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `MOVEMENT_FIXTURE_READY http://127.0.0.1:${port}/inventory-management`,
    ),
  );
}
