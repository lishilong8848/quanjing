const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measure(page, action, ready) {
  return page.evaluate(({ action, ready }) => new Promise(resolve => {
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (!(new Function(`return (${ready})`)())) return;
      observer.disconnect();
      requestAnimationFrame(() => resolve(performance.now() - started));
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    (new Function(action))();
  }), { action, ready });
}
(async () => {
  await fetch('http://127.0.0.1:4201/__qa/control?mode=normal&role=admin');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    await page.addInitScript(() => {
      window.__meetingLongTasks = [];
      new PerformanceObserver(list => {
        window.__meetingLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
      }).observe({ type: 'longtask', buffered: true });
    });
    await page.goto('http://127.0.0.1:4200/meeting-management', { waitUntil: 'domcontentloaded' });
    await page.locator('.meeting-connected-source').filter({ hasText: '41 条' }).waitFor();
    const firstPaintReady = await page.evaluate(() => new Promise(resolve => {
      const started = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ timestamp: performance.now(), elapsedMs: performance.now() - started })));
    }));
    const filters = [], dialogs = [], weekly = [];
    for (let i = 0; i < 10; i++) {
      const value = i % 2 === 0 ? '客户' : '';
      filters.push(await measure(page, `const s=document.querySelector('select[aria-label="总览范围"]');s.value='${value}';s.dispatchEvent(new Event('change',{bubbles:true}));`, `document.querySelector('.meeting-overview-metric strong')?.textContent === '${value ? '15' : '68'}场'`));
    }
    const initialDemoDialogMs = await measure(page, `document.querySelector('.meeting-scope-card button').click()`, `!!document.querySelector('.meeting-demo-dialog')`);
    await page.getByLabel('关闭', { exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    for (let i = 0; i < 10; i++) {
      dialogs.push(await measure(page, `document.querySelector('.meeting-scope-card button').click()`, `!!document.querySelector('.meeting-demo-dialog')`));
      await page.getByLabel('关闭', { exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.getByRole('link', { name: '南通属地周会', exact: true }).click();
    await page.locator('.meeting-action-source').first().click();
    await page.locator('.meeting-detail-footer').waitFor();
    await page.getByLabel('关闭', { exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    for (let i = 0; i < 10; i++) {
      weekly.push(await measure(page, `document.querySelector('.meeting-action-source').click()`, `!!document.querySelector('.meeting-detail')`));
      await page.getByLabel('关闭', { exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    const longTasks = await page.evaluate(() => window.__meetingLongTasks);
    const evidence = { mode: 'production', kind: 'DOM-operation-to-next-frame', firstPaintReady, initialDemoDialogMs, longTasks, filters, dialogs, weekly,
      filterP95: p95(filters), demoDialogP95: p95(dialogs), weeklyDialogP95: p95(weekly) };
    fs.writeFileSync(path.resolve(__dirname, '../../output/meeting-overview-validation/performance-proof.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    assert(evidence.filterP95 <= 100, '总览筛选 P95 超过100ms');
    assert(evidence.demoDialogP95 <= 150, '演示下钻 P95 超过150ms');
    assert(evidence.weeklyDialogP95 <= 150, '真实待办来源下钻 P95 超过150ms');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
