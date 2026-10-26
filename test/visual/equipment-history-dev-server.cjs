const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/equipment-ledger-browser');
const output = path.join(root, 'output/equipment-history-check/browser');
fs.mkdirSync(output, { recursive: true });
const compiler = rspack({
  context: root,
  mode: 'development',
  devtool: false,
  target: 'web',
  entry: path.join(fixture, 'history-entry.tsx'),
  output: {
    path: output,
    filename: 'app.js',
    cssFilename: 'app.css',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
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
  } else compiler.close(start);
});
async function start() {
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS', moduleResolution: 'node' },
  });
  require('tsconfig-paths').register({
    baseUrl: root,
    paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
  });
  const {
    mapLedgerRecords,
  } = require('../../server/modules/equipment-lifecycle/equipment-ledger.model');
  const {
    matchEquipmentRepair,
    mapEquipmentRepair,
  } = require('../../server/modules/equipment-lifecycle/equipment-history.model');
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  const ledger = read(
    'output/equipment-history-card-planning/full-audit-2026-10-02/ledger.json',
  ).records;
  const repairs = read(
    'output/equipment-history-check/live-repair-source.json',
  ).records;
  const aliases = new Map(ledger.map((r) => [r.id, r.fields['楼栋标识']]));
  const assets = mapLedgerRecords(ledger).map((a) => ({
    ...a,
    buildingAlias: aliases.get(a.id),
  }));
  const matches = matchEquipmentRepair(assets, repairs);
  const histories = new Map();
  for (const record of repairs) {
    const row = mapEquipmentRepair(record),
      id = matches.get(row.id)?.assetId;
    if (id) histories.set(id, [...(histories.get(id) || []), row]);
  }
  for (const list of histories.values())
    list.sort(
      (a, b) =>
        (b.faultAt || b.startedAt || '').localeCompare(
          a.faultAt || a.startedAt || '',
        ) || b.repairNumber.localeCompare(a.repairNumber),
    );
  const completed =
    [...histories].find(
      ([, list]) =>
        list.length > 1 && list.every((r) => r.status === '维修完成'),
    ) || [...histories].find(([, list]) => list[0].status === '维修完成');
  const pending = [...histories].find(([, list]) =>
    list.some((r) => r.status === '未开始'),
  );
  const empty = assets.find(
    (a) => a.kind === 'detail' && a.quantity === 1 && !histories.has(a.id),
  );
  const picks = [
    assets.find((a) => a.id === completed[0]),
    assets.find((a) => a.id === pending[0]),
    empty,
  ];
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:43194');
    const json = (value, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/fixture/assets') return json(picks);
    if (url.pathname === '/fixture/stats') return json(calls);
    if (url.pathname === '/api/equipment-ledger/history') {
      const id = url.searchParams.get('assetId'),
        mode = url.searchParams.get('__case');
      calls.push({ id, mode, at: Date.now() });
      const attempt = calls.filter(
        (c) => c.id === id && c.mode === mode,
      ).length;
      if (mode === 'error' && attempt === 1)
        return json({ error: 'offline' }, 503);
      const ready = {
        assetId: id,
        status: 'ready',
        refreshing: false,
        stale: mode === 'stale',
        updatedAt: new Date().toISOString(),
        items: histories.get(id) || [],
        error: mode === 'stale' ? '维修记录更新失败，请重试' : '',
      };
      if (
        mode === 'cold' &&
        calls.filter((c) => c.id === id && c.mode === mode).length < 3
      )
        return json({
          ...ready,
          status: 'loading',
          refreshing: true,
          items: [],
        });
      if (mode === 'late' || (mode === 'timeout' && attempt === 1))
        return setTimeout(() => json(ready), 2000);
      return json(ready);
    }
    if (url.pathname === '/app.js' || url.pathname === '/app.css') {
      res.setHeader(
        'Content-Type',
        url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
      );
      return res.end(fs.readFileSync(path.join(output, url.pathname.slice(1))));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备机历开发验收</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>',
    );
  });
  server.listen(43194, '127.0.0.1', () =>
    console.log('HISTORY_BROWSER_READY http://127.0.0.1:43194'),
  );
}
