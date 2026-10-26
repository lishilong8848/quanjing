const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict'), os = require('node:os');
const { chromium } = require('playwright-core'), installProbe = require('./probe.cjs');
const root = path.resolve(__dirname, '../../..'), base = path.join(root, 'output/personnel-stage-three-full-20261015');
const source = path.join(base, 'unified-interaction-native-production-final'), name = process.argv[2];
if (!/^[a-z0-9-]+$/.test(name || '')) throw Error('Unique evidence phase required');
const modes = process.argv.slice(3); if (new Set(modes).size !== modes.length || modes.some(mode => !['mobile-only', 'headed', 'trace-three', 'gpu-trace-three'].includes(mode))) throw Error('Unknown mode');
const mobileOnly = modes.includes('mobile-only'), headed = modes.includes('headed'), gpuTrace = modes.includes('gpu-trace-three'), diagnostic = modes.includes('trace-three') || gpuTrace;
if (diagnostic && (!headed || mobileOnly)) throw Error('Trace diagnostic uses the specified headed desktop environment');
const viewports = diagnostic ? ['desktop'] : mobileOnly ? ['mobile'] : ['desktop', 'mobile'];
const output = path.join(base, name); if (fs.existsSync(output)) throw Error('Evidence exists'); fs.mkdirSync(output);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = JSON.parse(fs.readFileSync(path.join(source, 'proof.json'), 'utf8'));
assert.deepEqual(original.sourceBefore, original.sourceAfter);
for (const row of original.sourceAfter) assert.equal(hash(row.path), row.sha256, 'Original component input drift: ' + row.path);
const started = Date.now(), cpu = process.cpuUsage(), proof = { passed: false, originalPassed: original.passed, startedAt: new Date().toISOString(), samples: [], checkboxContext: [], performance: [], errors: [], externalRequests: [], screenshots: [],
  command: [process.execPath, ...process.argv.slice(1)], diagnosticOnly: diagnostic, viewports, environment: { node: process.version, platform: process.platform, cpus: os.cpus().length, freeMemoryStart: os.freemem(), browserMode: headed ? 'headed' : 'headless', compilerLoaded: false },
  scope: 'One fixed artifact-only round, no Rspack/compilation, no client source change. Original negative results retained; DOM/RAF are not physical paint. EventTiming is browser-reported quantized rendering latency, missing entries remain null.' };
let browser, server, traceClient, tracing = false, before = [], inputs = [];
async function stopTrace() {
  if (!tracing) return; tracing = false;
  const completed = new Promise(done => traceClient.once('Tracing.tracingComplete', done));
  await traceClient.send('Tracing.end'); const { stream } = await completed;
  const target = path.join(output, 'browser-trace.json'), chunks = []; let bytes = 0;
  try { while (true) { const chunk = await traceClient.send('IO.read', { handle: stream }); const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
    bytes += data.length; if (bytes > 64 * 1024 * 1024) throw Error('Bounded trace exceeded 64MiB'); chunks.push(data); if (chunk.eof) break;
  } fs.writeFileSync(target, Buffer.concat(chunks)); proof.trace = { path: target, size: bytes, sha256: hash(target), complete: true }; }
  finally { await traceClient.send('IO.close', { handle: stream }); }
}
async function main() {
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node' } });
  const { overview, preview } = require('../personnel-duty-handover/fixture.ts');
  const driver = path.join(__dirname, 'run.cjs'), text = fs.readFileSync(driver, 'utf8'), start = text.indexOf(' server=http.createServer('), end = text.indexOf('await new Promise(resolve=>server.listen', start);
  assert(start >= 0 && end > start); const protocol = text.slice(start, end), recovery = text.match(/let recovery=(\{.*?\});\r?\nconst hash/s)?.[1]; assert(recovery);
  proof.protocol = { driver, sha256: hash(driver), extractedBlockSha256: crypto.createHash('sha256').update(protocol).digest('hex') };
  const continuation = mobileOnly ? path.join(base, 'unified-recovery-artifact-fixed-final/proof.json') : undefined;
  if (continuation) { assert.equal(hash(continuation), '68cf7c4e8187d4ac7a67fbac199e66c7edcb6009b857e3de3efb1b4c3789122d'); proof.continues = { path: continuation, sha256: hash(continuation), rerunsDesktop: false }; }
  inputs = [...new Set([__filename, driver, path.join(__dirname, 'probe.cjs'), path.join(root, 'output/release-stage-three-activation-after-144241-20261016/UI-ARTIFACT-ACCEPTANCE-PLAN.md'),
    path.join(root, 'test/visual/personnel-duty-handover/fixture.ts'), path.join(source, 'proof.json'), path.join(source, 'app.js'), path.join(source, 'app.css'), process.execPath,
    path.join(root, 'package-lock.json'), ...(continuation ? [continuation] : []), ...original.sourceAfter.map(row => row.path), ...Object.keys(require.cache)])].sort();
  const capture = () => inputs.map(file => ({ path: file, sha256: hash(file) })); before = capture();
  server = new Function('http', 'proof', 'overview', 'preview', 'output', 'fs', 'path', 'assert', `let server,batch;let recovery=${recovery};${protocol}return server;`)(http, proof, overview, preview, source, fs, path, assert);
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: !headed }); proof.environment.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); await page.addInitScript(installProbe);
  await page.addInitScript(() => {
    window.__renderEvidence = { supported: PerformanceObserver.supportedEntryTypes.includes('event'), entries: [], events: [], longTasks: [], longFrames: [] };
    const evidence = window.__renderEvidence;
    if (evidence.supported) new PerformanceObserver(list => evidence.entries.push(...list.getEntries().map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration,
      processingStart: entry.processingStart, processingEnd: entry.processingEnd, interactionId: entry.interactionId, targetName: entry.target?.textContent?.slice(0, 40) })))).observe({ type: 'event', durationThreshold: 16 });
    for (const [type, key] of [['longtask', 'longTasks'], ['long-animation-frame', 'longFrames']]) if (PerformanceObserver.supportedEntryTypes.includes(type))
      new PerformanceObserver(list => evidence[key].push(...list.getEntries().map(entry => entry.toJSON()))).observe({ type, buffered: true });
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
      if (!event.target.closest('[data-feedback-target]')) return;
      evidence.events.push({ type, timeStamp: event.timeStamp, at: performance.now(), trusted: event.isTrusted, visibility: document.visibilityState, hasFocus: document.hasFocus() });
    }, true);
  });
  page.on('pageerror', error => proof.errors.push(error.stack || error.message));
  await page.route('**/*', route => { if (!route.request().url().startsWith(origin)) { proof.externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  async function measured(locator, description) {
    await page.locator('[data-feedback-target]').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('data-feedback-target')));
    await locator.evaluate(node => node.setAttribute('data-feedback-target', 'true'));
    const eventStart = await page.evaluate(() => window.__renderEvidence.events.length);
    await page.evaluate(value => window.__uiFeedback.arm(value), description); await locator.click();
    await page.waitForFunction(() => window.__uiFeedback.rows.at(-1)?.complete);
    return { ...await page.evaluate(() => window.__uiFeedback.rows.at(-1)), nativeEvents: await page.evaluate(index => window.__renderEvidence.events.slice(index), eventStart) };
  }
  const dialog = page.getByRole('dialog');
  for (const viewport of viewports) {
    await page.request.post(origin + '/__fixture/reset');
    await page.setViewportSize({ width: viewport === 'desktop' ? 1440 : 390, height: 1050 }); await page.goto(origin);
    await page.getByRole('tab', { name: '岗位交接', exact: true }).click(); await page.getByRole('combobox', { name: '前任人员', exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复签收', exact: true }).click(); await dialog.getByRole('checkbox').waitFor();
    for (const phase of ['warm', 'formal']) for (let index = 0; index < (phase === 'warm' ? 3 : viewport === 'desktop' ? 20 : 10); index++) {
      const box = dialog.getByRole('checkbox'); proof.checkboxContext.push(await measured(box, { label: 'recovery-checkbox', phase: `${viewport}-${phase}`, kind: 'checkbox', expected: String(!await box.isChecked()) }));
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    if (diagnostic) {
      traceClient = await page.context().newCDPSession(page);
      const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'toplevel', 'cc', 'input', 'renderer.scheduler', 'latencyInfo'];
      if (gpuTrace) {
        const available = (await traceClient.send('Tracing.getCategories')).categories;
        const selected = available.filter(value => /^(gpu|viz|skia|d3d|dcomp)$|^disabled-by-default-gpu\.(service|debug|device)$|^disabled-by-default-viz\.(gpu_composite_time|debug\.overlay_planes)$/.test(value));
        if (available.length && !selected.includes('gpu')) throw Error('Browser did not expose the required GPU trace category');
        if (!available.length) selected.push('gpu');
        categories.push(...selected); proof.gpuTraceCategories = { discoveryCount: available.length, available: available.filter(value => /gpu|viz|d3d|dcomp|skia/.test(value)), selected,
          source: 'https://chromium.googlesource.com/chromium/src/gpu/+/df937685a3f6d74f411fc8d38cc45605fb8a4d6d/command_buffer/service/scheduler.cc',
          limitation: 'An empty getCategories result is not capability denial. The gpu category is supported by primary source; actual emitted trace events, not this source link, must establish this runtime capture.' };
        const browserClient = await browser.newBrowserCDPSession();
        try { const info = await browserClient.send('SystemInfo.getInfo'); proof.gpuInfo = { devices: info.gpu.devices.map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId,
          vendorString: device.vendorString, deviceString: device.deviceString, driverVendor: device.driverVendor, driverVersion: device.driverVersion })),
          glRenderer: info.gpu.auxAttributes?.glRenderer, glVendor: info.gpu.auxAttributes?.glVendor, displayType: info.gpu.auxAttributes?.displayType, featureStatus: info.gpu.featureStatus }; }
        finally { await browserClient.detach(); }
        console.log(JSON.stringify({ gpuTraceCategories: selected, gpuInfo: proof.gpuInfo }));
      }
      proof.selectedTraceCategories = [...new Set(categories)];
      await traceClient.send('Tracing.start', { categories: proof.selectedTraceCategories.join(','), transferMode: 'ReturnAsStream' }); tracing = true;
    }
    for (const phase of diagnostic ? ['diagnostic'] : ['warm', 'formal']) for (let index = 0; index < (diagnostic || phase === 'warm' ? 3 : 10); index++) {
      await page.request.post(origin + '/__fixture/reset'); await page.getByRole('button', { name: '更新任务', exact: true }).click();
      await page.getByRole('button', { name: '恢复签收', exact: true }).click(); await dialog.getByRole('checkbox').check();
      if (diagnostic) await page.evaluate(index => performance.mark('recovery-diagnostic-' + index), index + 1);
      const row = await measured(dialog.getByRole('button', { name: '确认恢复', exact: true }), { label: 'recovery-submit', phase: `${viewport}-${phase}`, kind: 'busy', expected: '正在提交' });
      proof.samples.push(row);
      if (phase === 'formal' && [0, 9].includes(index)) { const file = `${viewport}-formal-${index + 1}.png`; await page.screenshot({ path: path.join(output, file) }); proof.screenshots.push({ path: file, sha256: hash(path.join(output, file)), afterProbe: true }); }
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      row.renderEvidence = await page.evaluate(events => { const records = window.__renderEvidence.entries; return { supported: window.__renderEvidence.supported,
        click: events.filter(event => event.type === 'click').map(event => ({ event, timing: records.find(entry => entry.name === 'click' && Math.abs(entry.startTime - event.timeStamp) < 1) || null })) }; }, row.nativeEvents);
      console.log(JSON.stringify({ viewport, phase, index: index + 1, domMs: row.domMs, rafMs: row.rafMs, renderingEntries: row.renderEvidence.click.filter(row => row.timing).length }));
    }
    proof[viewport + 'Rendering'] = await page.evaluate(() => window.__renderEvidence);
  }
  if (diagnostic) { await stopTrace(); proof.diagnosticFinished = true; }
  for (const viewport of diagnostic ? [] : viewports) {
    const rows = proof.samples.filter(row => row.phase === viewport + '-formal'); assert.equal(rows.length, 10);
    const values = rows.map(row => row.rafMs), sorted = [...values].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1], max = sorted.at(-1);
    proof.performance.push({ viewport, count: rows.length, raw: values, p95, max, limit: 150, passed: rows.every(row => row.complete && !row.error && row.rafMs !== null && row.nativeEvents.some(event => event.type === 'click' && event.trusted)) && p95 <= 150 && max <= 150 });
  }
  assert(!Object.keys(require.cache).some(file => file.includes(path.sep + '@rspack' + path.sep)), 'Compiler must not be loaded');
  assert.deepEqual(before, capture()); assert.deepEqual(proof.errors, []);
  const knownFont = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  assert(proof.externalRequests.every(url => url === knownFont), 'Unexpected external request');
  proof.fontResource = { requested: proof.externalRequests.includes(knownFont), blocked: true, policyUnchanged: true, limitation: 'Existing declared webfont remains blocked, no real external font-loading proof.' };
  proof.passed = !diagnostic && proof.performance.every(row => row.passed); if (!diagnostic && !proof.passed) process.exitCode = 1;
}
main().catch(error => { proof.errors.push(error.stack); process.exitCode = 1; }).finally(async () => {
  try { await stopTrace(); } catch (error) { proof.errors.push(error.stack); process.exitCode = 1; }
  if (browser) await browser.close(); if (server) await new Promise(done => server.close(done));
  proof.sourceBefore = before; proof.sourceAfter = inputs.map(file => ({ path: file, sha256: hash(file) })); proof.environment.cpuMicros = process.cpuUsage(cpu);
  proof.environment.freeMemoryEnd = os.freemem(); proof.elapsedMs = Date.now() - started; proof.completedAt = new Date().toISOString();
  proof.cleanup = { browserClosed: !!browser && !browser.isConnected(), serverClosed: !!server && !server.listening };
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ passed: proof.passed, samples: proof.samples.length, performance: proof.performance, errors: proof.errors, cleanup: proof.cleanup, elapsedMs: proof.elapsedMs }));
});
