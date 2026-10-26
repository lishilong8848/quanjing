const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/monthly-last30-browser');
const output = path.join(root, 'output/monthly-last30-check');
fs.mkdirSync(output, { recursive: true });
const started = Date.now();
const compiler = rspack({
  context: root, mode: 'development', devtool: false, target: 'web',
  entry: path.join(fixture, 'entry.tsx'),
  output: { path: output, filename: 'app.js', cssFilename: 'app.css', publicPath: '/' },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@/access/AccessProvider$': path.join(fixture, 'access.ts'),
      '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared'),
      '@lark-apaas/client-toolkit/logger$': path.join(fixture, 'api.ts'),
      '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': path.join(fixture, 'api.ts'),
    },
  },
  module: { rules: [
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: {
      jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' },
    } } },
    { test: /\.css$/, type: 'css/auto', use: { loader: 'postcss-loader', options: {
      postcssOptions: { plugins: { '@tailwindcss/postcss': {} } },
    } } },
  ] },
  experiments: { css: true },
});
compiler.run((error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    compiler.close(() => {}); process.exitCode = 1; return;
  }
  compiler.close(start);
});
function resources(range) {
  const stamp = { status: 'ready', syncedAt: new Date().toISOString() };
  const buildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
  const days = [];
  for (let date = range.start; date <= range.asOf; date = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    for (const building of [...buildings, '园区']) days.push({ date, building,
      pue: 1.25, total: 12500, it: 10000, nonIt: 2500, cooling: 1800,
      terminal: 500, auxiliary: 200, pueWeight: 10000,
    });
  }
  return {
    range: { ...range, trendStart: range.start },
    racks: { ...stamp, month: range.asOf.slice(0, 7), rows: buildings.map(building => ({ building, date: range.asOf, capacity: 1000, online: 750, rate: 75 })), history: [] },
    rackMovements: { ...stamp, rows: [] }, energy: { ...stamp, days },
    weather: { ...stamp, days: days.map(row => ({ date: row.date, building: row.building, value: 25, samples: 24 })) },
    water: { ...stamp, days: days.map(row => ({ date: row.date, building: row.building, water: 100, waterEast: 60, waterWest: 40, wue: 1, wueWeight: 10000 })) },
    load: { ...stamp, date: range.asOf, park: 50, rows: buildings.map(building => ({ building, value: 50 })) },
  };
}
function start() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:43196');
    if (url.pathname === '/diagnostics') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ requests })); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const params = Object.fromEntries(url.searchParams);
      requests.push({ path: url.pathname, ...params, at: Date.now() });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
      const range = { start: params.start, end: params.end, asOf: params.end < today ? params.end : today };
      const delay = params.__case === 'late' || params.__case === 'timeout' ? 1500 : 120;
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        if (params.__case === 'error') { res.statusCode = 503; res.end(JSON.stringify({ message: '测试读取失败' })); return; }
        const data = url.pathname.endsWith('resources') ? resources(range) : {
          range, kind: params.kind, status: 'empty', syncedAt: new Date().toISOString(), records: [],
          tagReview: { state: 'ready' }, sources: [],
        };
        res.end(JSON.stringify(data));
      }, delay);
      return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>智舱月览过去30天验收</title></head><body><div id="root"></div><pre id="measurements" hidden></pre><script src="/app.js"></script></body></html>'); return;
    }
    const name = url.pathname.slice(1);
    if (!['app.js', 'app.css'].includes(name)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
    fs.createReadStream(path.join(output, name)).pipe(res);
  });
  server.listen(43196, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: 43196, compileMs: Date.now() - started })));
}
