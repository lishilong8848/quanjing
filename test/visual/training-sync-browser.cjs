// Synthetic localhost fixture; no Nest bootstrap, dotenv, external APIs, or production build.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { rspack, DefinePlugin } = require('@rspack/core');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..'), name = process.argv[2];
if (!/^[a-z0-9-]+$/.test(name || '')) throw Error('Use a unique evidence name');
const output = path.join(root, 'output/training-sync-fix-20261027', name);
if (fs.existsSync(output)) throw Error('Evidence directory already exists');
fs.mkdirSync(output, { recursive: true });
const keepOpen = process.argv.includes('--keep-open');
const reuseIndex = process.argv.indexOf('--reuse-build');
const reuseName = reuseIndex < 0 ? null : process.argv[reuseIndex + 1];
if (reuseName && !/^[a-z0-9-]+$/.test(reuseName)) throw Error('Invalid reusable build name');
const assetRoot = reuseName ? path.join(root, 'output/training-sync-fix-20261027', reuseName) : output;
const proof = { passed: false, checks: [], errors: [], externalRequests: [], screenshots: [] };
const metrics = ['annualCompletedCourses', 'monthlyPlannedCourses', 'monthlyParticipants', 'monthlyNewHires', 'historicalSharingSessions', 'monthlyPlannedSharingSessions'];
function dashboard(month, status, noSuccess = false) {
  return {
    month, availableMonths: ['2026-10', '2026-09'],
    summary: Object.fromEntries(metrics.map(key => [key, 0])),
    metricComparisons: Object.fromEntries(metrics.map(key => [key, { change: 0, direction: 'up', favorable: true }])),
    metricTrends: Object.fromEntries(metrics.map(key => [key, []])),
    progress: [], participation: [], newHirePlans: [], courses: [],
    sharing: { categories: [], trend: [], participants: 0, totalHours: 0, satisfaction: 0, materials: 0, interests: [] },
    details: { assessmentPassScore: 80, activeCoursePlans: [], participants: [], newHires: [], sharingSessions: [], reconciliationNotes: [] },
    sourceUpdatedAt: '2099-12-31T12:59:00Z',
    syncedAt: noSuccess ? '' : status === 'fresh' ? '2026-10-27T01:02:00Z' : '2026-10-14T19:10:19.940Z',
    sourceStatus: status, dataStatus: 'ready',
    ...(status === 'stale' ? { errorMessage: '合成源同步失败，请刷新重试' } : {}),
  };
}
let scenario, server, browser, page;
function configure(replies) { scenario = { replies, requests: [], active: 0, maxActive: 0 }; }
function gate(status = 'fresh') { let release; return { status, wait: new Promise(resolve => { release = resolve; }), release: () => release() }; }
const compiler = reuseName ? null : rspack({
  context: root, mode: 'development', devtool: false, target: 'web',
  entry: path.join(root, 'test/fixtures/training-sync-browser/entry.tsx'),
  output: { path: output, filename: 'app.js', chunkFilename: '[id].js', cssFilename: 'app.css', cssChunkFilename: '[id].css', publicPath: '/' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@/api$': path.join(root, 'test/fixtures/training-sync-browser/api.ts'), '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared') } },
  module: { rules: [
    { test: /\.svg$/, type: 'asset/inline' },
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
    { test: /\.css$/, type: 'css/auto', use: { loader: 'postcss-loader', options: { postcssOptions: { plugins: { '@tailwindcss/postcss': {} } } } } },
  ] }, experiments: { css: true }, plugins: [new DefinePlugin({ 'process.env.CLIENT_BASE_PATH': JSON.stringify('') })],
});
async function main() {
  if (reuseName) {
    const prior = JSON.parse(fs.readFileSync(path.join(assetRoot, 'proof.json'), 'utf8'));
    assert(prior.sourceHashes?.length, 'Prior compilation source binding missing');
    for (const entry of prior.sourceHashes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.path))).digest('hex'), entry.sha256, `Compiled source changed: ${entry.path}`);
    proof.sourceHashes = prior.sourceHashes; proof.reusedBuild = assetRoot;
  } else {
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    if (!error && !stats.hasErrors()) proof.sourceHashes = [...stats.compilation.fileDependencies]
      .filter(file => file.startsWith(root + path.sep) && !file.includes(path.sep + 'node_modules' + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      .sort().map(file => ({ path: path.relative(root, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve());
  }));
  }
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/bitable/campus-training-dashboard') {
      const current = scenario, preview = req.headers.referer && new URL(req.headers.referer).searchParams.get('preview');
      const reply = preview ? { status: preview } : current.replies[Math.min(current.requests.length, current.replies.length - 1)];
      current.requests.push({ month: url.searchParams.get('month'), forceRefresh: url.searchParams.get('forceRefresh') });
      current.active++; current.maxActive = Math.max(current.maxActive, current.active);
      await reply.wait;
      current.active--;
      res.writeHead(reply.status === 'error' ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(reply.status === 'error' ? { message: 'Synthetic unavailable' } : dashboard(url.searchParams.get('month') || '2026-10', reply.status, reply.noSuccess)));
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Synthetic API only'); }
    const filename = url.pathname.slice(1);
    if (/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(filename) && fs.existsSync(path.join(assetRoot, filename))) {
      res.writeHead(200, { 'Content-Type': filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return fs.createReadStream(path.join(assetRoot, filename)).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-src 'none'" });
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  configure([{ status: 'fresh' }]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  proof.origin = origin; proof.pid = process.pid;
  proof.previewUrls = Object.fromEntries(['fresh', 'refreshing', 'stale'].map(status => [status, `${origin}/training-certification-management?module=training&preview=${status}`]));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { proof.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Synthetic request wait timed out'); };
  const header = page.locator('.training-certification-hero-actions');
  await page.clock.install({ time: new Date('2026-10-27T01:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-27T01:00:00Z'));
  async function open(replies) {
    configure(replies);
    await page.clock.setSystemTime(new Date('2026-10-27T01:00:00Z'));
    await page.goto(`${origin}/training-certification-management?module=training`);
    await waitFor(async () => {
      await page.clock.runFor(50);
      return page.evaluate(() => !!document.querySelector('[data-screenshot-ready="true"]'));
    });
  }
  async function fresh() { await waitFor(() => page.evaluate(() => document.querySelector('.training-certification-hero-actions')?.textContent.includes('2026-10-27 09:02'))); }
  async function capture(label, width, height, status = 'fresh') {
    const visual = await browser.newPage({ viewport: { width, height }, timezoneId: 'Asia/Shanghai' });
    visual.on('pageerror', error => proof.errors.push(error.message));
    await visual.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { proof.externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await visual.goto(`${origin}/training-certification-management?module=training&preview=${status}`);
    await visual.waitForSelector('[data-screenshot-ready="true"]');
    await visual.waitForTimeout(1_200);
    const overflow = await visual.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${label} horizontal overflow`);
    let banner;
    if (status !== 'fresh') {
      banner = await visual.locator('.training-dashboard-state-banner').evaluate(element => {
        const rect = element.getBoundingClientRect(), text = element.querySelector('span')?.getBoundingClientRect(), button = element.querySelector('button')?.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, textWidth: text?.width, textRight: text?.right, buttonLeft: button?.left };
      });
      assert(banner.top >= 0 && banner.bottom <= height, `${label} banner outside first viewport`);
      assert(banner.left >= 0 && banner.right <= width && banner.textWidth >= 120, `${label} warning text squeezed`);
      if (banner.buttonLeft !== undefined) assert(banner.textRight <= banner.buttonLeft, `${label} button overlaps text`);
    }
    const file = path.join(output, `${label}.png`); await visual.screenshot({ path: file, fullPage: true });
    proof.screenshots.push({ file, width, height, overflow, banner, realClock: true });
    const viewportFile = path.join(output, `${label}-viewport.png`);
    await visual.screenshot({ path: viewportFile });
    proof.screenshots.push({ file: viewportFile, width, height, overflow, banner, realClock: true, viewportOnly: true });
    await visual.close();
  }

  await open([{ status: 'refreshing', noSuccess: true }]);
  assert((await header.innerText()).includes('培训管理数据准备中'));
  assert(!(await header.innerText()).includes('2099'));
  assert.equal(await page.getByText('源数据同步失败，已展示上次成功结果', { exact: true }).count(), 0);
  await page.clock.runFor(61_000); await waitFor(() => scenario.requests.length >= 2 && scenario.active === 0);
  scenario.replies = [{ status: 'fresh' }];
  await page.clock.runFor(4_000); await fresh();
  assert.equal(scenario.maxActive, 1); proof.checks.push('refreshing remains observable after60seconds; fresh completes; no fabricated update time; serial polls');

  await open([{ status: 'stale' }, { status: 'fresh' }]);
  assert((await header.innerText()).includes('2026-10-15 03:10'));
  await page.clock.runFor(310_000); assert.equal(scenario.requests.length, 1);
  await page.getByRole('button', { name: '刷新重试', exact: true }).click(); await fresh();
  assert.equal(scenario.requests[1].forceRefresh, '1');
  proof.checks.push('stale stops automatic reads and explicit refresh recovers');

  await open([{ status: 'refreshing' }, { status: 'error' }, { status: 'fresh' }]);
  await page.clock.runFor(3_000); await page.getByText('暂时无法确认同步进度，已暂停自动查询。请点击刷新重试。', { exact: true }).waitFor();
  await page.clock.runFor(310_000); assert.equal(scenario.requests.length, 2);
  await header.getByRole('button', { name: '刷新', exact: true }).click(); await fresh();
  proof.checks.push('one failed poll stops; manual refresh retries');

  await open([{ status: 'stale' }]);
  for (let i = 0; i < 3; i++) {
    await header.getByRole('button', { name: '刷新', exact: true }).click();
    await waitFor(() => scenario.requests.length === i + 2 && scenario.active === 0);
    await waitFor(() => page.evaluate(() => document.querySelector('[data-screenshot-ready="true"]') !== null));
    assert.equal(await page.locator('.training-metric-card').count(), 6);
    assert((await header.innerText()).includes('2026-10-15 03:10'));
  }
  await page.clock.runFor(310_000); assert.equal(scenario.requests.length, 4);
  proof.checks.push('repeated failed manual refresh preserves existing cards and last-success time without auto retry');

  const pending = gate('fresh');
  await open([{ status: 'refreshing' }, pending]);
  await page.clock.runFor(3_000); await waitFor(() => scenario.requests.length === 2);
  await page.clock.runFor(300_000);
  await page.getByText('后台同步仍未完成，已暂停自动查询。请稍后点击刷新查看结果。', { exact: true }).waitFor();
  assert.equal(scenario.requests.length, 2); assert.equal(scenario.maxActive, 1);
  pending.release(); await fresh();
  assert.equal(await page.getByText('后台同步仍未完成，已暂停自动查询。请稍后点击刷新查看结果。', { exact: true }).count(), 0);
  proof.checks.push('bounded wait gives actionable hint; in-flight success clears it');

  const oldMonth = gate('fresh');
  await open([{ status: 'refreshing' }, oldMonth, { status: 'refreshing' }, { status: 'fresh' }]);
  await page.clock.runFor(3_000); await waitFor(() => scenario.requests.length === 2);
  await page.getByRole('combobox', { name: '统计月份' }).click();
  await page.getByRole('option', { name: '2026-09', exact: true }).click();
  await waitFor(() => scenario.requests.length === 3);
  await waitFor(() => page.evaluate(() => document.querySelector('[role="combobox"]')?.textContent.includes('2026-09')));
  await page.clock.runFor(10_000); assert.equal(scenario.requests.length, 3);
  oldMonth.release(); await waitFor(() => scenario.active === 0);
  await page.clock.runFor(4_000); await fresh();
  assert.equal(await page.getByRole('combobox', { name: '统计月份' }).innerText(), '2026-09');
  assert.equal(scenario.requests.at(-1).month, '2026-09');
  proof.checks.push('month change supersedes delayed old response and prevents overlapping automatic polls');
  for (const [device, width, height] of [['mobile', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]]) {
    await capture(`${device}-stale`, width, height, 'stale');
    await capture(`${device}-refreshing`, width, height, 'refreshing');
    await capture(`${device}-success`, width, height);
  }
  assert.deepEqual(proof.errors, []); assert.deepEqual(proof.externalRequests, []); proof.passed = true;
}
main().catch(async error => {
  proof.errors.push(error.stack || String(error)); process.exitCode = 1;
  proof.lastRequests = scenario?.requests;
  if (page) {
    proof.lastPageText = await page.locator('body').innerText().catch(() => 'unavailable');
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  }
}).finally(async () => {
  await browser?.close();
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ passed: proof.passed, output, origin: proof.origin, pid: process.pid, keepOpen }));
  if (!keepOpen || !proof.passed) server?.close();
});
const stop = () => server?.close(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
