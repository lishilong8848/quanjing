const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { rspack } = require('@rspack/core'), { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../../..'), name = process.argv[2], keepOpen = process.argv.includes('--keep-open');
if (!/^[a-z0-9-]+$/.test(name || '')) throw Error('Unique evidence name required');
const output = path.join(root, 'output/login-fix-20261026', name);
if (fs.existsSync(output)) throw Error('Evidence exists');
fs.mkdirSync(output, { recursive: true });
const started = Date.now(), proof = { passed: false, checks: [], errors: [], externalRequests: [] };
let sourcePaths = [], sourceBefore = [];
const fingerprint = () => sourcePaths.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const mock = path.join(root, 'test/fixtures/feishu-login-browser/api.ts');
const compiler = rspack({ context: root, mode: 'development', devtool: false, target: 'web',
  entry: path.join(__dirname, 'entry.tsx'), output: { path: output, filename: 'app.js', cssFilename: 'app.css', publicPath: '/' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], alias: {
    '@/api$': mock, '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared'),
    '@lark-apaas/client-toolkit/logger$': mock, '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': mock,
    '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$': mock, '@lark-apaas/client-toolkit/dataloom$': mock,
  } }, module: { rules: [
    { test: /\.svg$/, type: 'asset/inline' },
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
    { test: /\.css$/, type: 'css/auto', use: { loader: 'postcss-loader', options: { postcssOptions: { plugins: { '@tailwindcss/postcss': {} } } } } },
  ] }, experiments: { css: true }, plugins: [new (require('@rspack/core').DefinePlugin)({ 'process.env.CLIENT_BASE_PATH': JSON.stringify('') })],
});
let server, browser;
const guest = { role: 'guest', purchaseBuilding: null, expiresAt: null, principalFingerprint: null, pagePaths: ['/nantong-base'] };
const member = () => ({ role: 'editor', purchaseBuilding: null, expiresAt: Date.now() + 3600000,
  principalFingerprint: crypto.createHash('sha256').update('synthetic-member').digest('base64url'),
  accountId: 'feishu-' + crypto.createHash('sha256').update('synthetic-member').digest('hex'),
  authorizationVersion: 1, displayName: '合成验收人员', pagePaths: ['/organization', '/nantong-base'] });
let scenario = { replies: ['valid'], delay: 0, reads: 0, businessRequests: 0 };
function configure(replies, delay = 0) { scenario = { replies, delay, reads: 0, businessRequests: 0 }; }
function responseFor(kind) {
  return { status: kind === 'unavailable' ? 503 : 200, cookie: kind === 'valid' ? 'valid' : kind === 'duplicate' ? 'duplicate' : 'absent',
    body: kind === 'unavailable' ? { message: '合成身份服务暂时不可用' } : kind === 'valid' ? member() : guest };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const compilationStarted = Date.now();
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    if (!error && !stats.hasErrors()) {
      sourcePaths = [...stats.compilation.fileDependencies].filter(file => file.startsWith(root + path.sep) && !file.includes(path.sep + 'node_modules' + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile());
      sourcePaths.push(__filename, process.execPath, path.join(root, 'package-lock.json'));
      sourcePaths = [...new Set(sourcePaths)].sort(); sourceBefore = fingerprint();
    }
    compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve());
  }));
  proof.compilationMs = Date.now() - compilationStarted;
  if (process.argv.includes('--compile-only')) { proof.passed = true; return; }
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/api/access/session') {
      const current = scenario;
      const preview = req.headers.referer ? new URL(req.headers.referer).searchParams.get('preview') : null;
      const kind = preview || current.replies[Math.min(current.reads, current.replies.length - 1)];
      current.reads += 1;
      const result = responseFor(kind);
      await pause(current.delay);
      res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Access-Session-Cookie': result.cookie });
      return res.end(JSON.stringify(result.body));
    }
    if (pathname === '/api/fixture/business') {
      scenario.businessRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ synthetic: true }));
    }
    if (pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Synthetic API only'); }
    const file = pathname === '/app.js' ? 'app.js' : pathname === '/app.css' ? 'app.css' : null;
    if (file) { res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); return fs.createReadStream(path.join(output, file)).pipe(res); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-src 'none'" });
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  proof.origin = origin; proof.pid = process.pid;
  proof.previewUrls = Object.fromEntries(['valid', 'absent', 'duplicate', 'unavailable'].map(mode => [mode, `${origin}/organization?preview=${mode}&feishu_auth=success`]));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) { proof.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  async function openCallback(pathname = '/organization') {
    await page.goto(`${origin}${pathname}?feishu_auth=success&fixture=kept#kept`);
    await page.waitForFunction(() => !location.search.includes('feishu_auth'));
  }
  async function noBusiness() {
    assert.deepEqual(await page.evaluate(() => window.__fixtureBusiness), { mounts: 0, requests: 0 });
    assert.equal(scenario.businessRequests, 0);
  }
  async function noAutomaticDialog() {
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByText('飞书授权成功。', { exact: true }).count(), 0);
    assert.equal(await page.getByText('当前页面需要登录权限', { exact: true }).count(), 0);
  }
  async function success() {
    await page.getByTestId('business-page').waitFor();
    await page.getByTestId('identity').filter({ hasText: '合成验收人员' }).waitFor();
    await page.waitForFunction(() => window.__fixtureBusiness.requests === 1);
    assert.deepEqual(await page.evaluate(() => window.__fixtureBusiness), { mounts: 1, requests: 1 });
  }
  async function capture(label) {
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(metrics.width <= metrics.viewport && metrics.body <= metrics.viewport, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
    proof.checks.push({ name: label, ...metrics });
  }

  for (const pathname of ['/organization', '/nantong-base']) {
    configure(['valid'], 900);
    await openCallback(pathname);
    await page.getByText('正在确认登录身份…', { exact: true }).waitFor();
    await noBusiness();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await success();
    assert.equal(scenario.reads, 1);
    proof.checks.push(`${pathname}: pending callback mounts/requests=0, confirmed mounts/requests=1`);
  }

  configure(['absent', 'absent', 'valid']);
  await openCallback();
  await page.getByText('正在确认登录身份…', { exact: true }).waitFor();
  await noBusiness();
  await success(); assert.equal(scenario.reads, 3);
  assert.equal(new URL(page.url()).search, '?fixture=kept'); assert.equal(new URL(page.url()).hash, '#kept');
  proof.checks.push('Two anonymous reads followed by confirmed third read, other URL data retained');
  await capture('mobile-success');

  configure(['absent']); await openCallback();
  await page.getByText('当前页面没有收到登录会话。请重新确认身份，仍失败时重新登录。', { exact: true }).waitFor();
  await noBusiness(); await noAutomaticDialog(); assert.equal(scenario.reads, 3);
  proof.checks.push('Persistent anonymous response: exactly 3 reads, actionable error, no automatic login dialog');
  await capture('mobile-error');
  configure(['valid']);
  await page.getByRole('button', { name: '重新确认身份', exact: true }).click();
  await success(); assert.equal(scenario.reads, 1);
  proof.checks.push('Explicit identity retry recovers without another OAuth navigation');

  configure(['unavailable']); await openCallback();
  await page.getByText('身份服务暂不可用：合成身份服务暂时不可用', { exact: true }).waitFor();
  await noBusiness(); await noAutomaticDialog(); assert.equal(scenario.reads, 1);
  proof.checks.push('HTTP 503: one read, service error retained, no false permission denial');
  configure(['valid']);
  await page.getByTestId('callback').click(); await success(); assert.equal(scenario.reads, 1);
  proof.checks.push('New authorization history entry at the same URL can confirm after earlier failure');

  configure(['duplicate']); await openCallback();
  await page.getByText('浏览器存在重复的登录会话。请清除本站登录状态后重新登录。', { exact: true }).waitFor();
  await noBusiness(); await noAutomaticDialog(); assert.equal(scenario.reads, 1);
  proof.checks.push('Duplicate diagnostic: one read, no automatic retry');

  configure(['valid'], 900); await openCallback();
  await page.getByText('正在确认登录身份…', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await noBusiness(); await success(); assert.equal(scenario.reads, 1);
  assert.equal(await page.getByText('飞书授权成功。', { exact: true }).count(), 1);
  proof.checks.push('Synthetic persisted pageshow twice while pending: one session read and one success notification (not physical iOS bfcache)');

  await page.setViewportSize({ width: 1440, height: 900 });
  configure(['valid']); await openCallback(); await success(); await capture('desktop-success');
  configure(['unavailable']); await openCallback();
  await page.getByText('身份服务暂不可用：合成身份服务暂时不可用', { exact: true }).waitFor();
  await noBusiness(); await capture('desktop-error');
  assert.deepEqual(proof.errors, []); assert.deepEqual(proof.externalRequests, []);
  proof.sourceBefore = sourceBefore; proof.sourceAfter = fingerprint();
  assert.deepEqual(proof.sourceBefore, proof.sourceAfter); proof.passed = true;
}
main().catch(error => { proof.errors.push(error.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  proof.sourceBefore = sourceBefore; proof.sourceAfter = fingerprint(); proof.elapsedMs = Date.now() - started;
  proof.serverKeptOpen = Boolean(keepOpen && proof.passed);
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ...proof, sourceBefore: undefined, sourceAfter: undefined, inputs: sourceBefore.length }));
  if (proof.serverKeptOpen) {
    configure(['valid']);
    console.log(`Preview ready: ${proof.origin} ; PID ${process.pid}; stop this Node session with Ctrl+C after Responsively inspection.`);
    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } else if (server) await new Promise(resolve => server.close(resolve));
});
