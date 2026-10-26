const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  await fetch('http://127.0.0.1:4201/__qa/control?mode=normal&role=admin');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto('http://127.0.0.1:4200/meeting-management/history');
    await page.locator('.meeting-row-main').first().waitFor();
    await page.locator('.meeting-sync').waitFor({ state: 'hidden' });
    await page.locator('.meeting-row-main').first().click();
    await page.locator('.meeting-detail-footer').waitFor();
    await page.getByLabel('关闭', { exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const sample = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const started = performance.now();
            const observer = new MutationObserver(() => {
              if (!document.querySelector('.meeting-detail')) return;
              const commitMs = performance.now() - started;
              observer.disconnect();
              requestAnimationFrame(() =>
                resolve({ commitMs, frameMs: performance.now() - started }),
              );
            });
            observer.observe(document.body, { childList: true, subtree: true });
            document.querySelector('.meeting-row-main').click();
          }),
      );
      samples.push(sample);
      await page.getByLabel('关闭', { exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    const filterSamples = [];
    for (let i = 0; i < 10; i++) {
      const sample = await page.evaluate((value) => new Promise(resolve => {
        const started = performance.now();
        const observer = new MutationObserver(() => {
          const matched = value === '客户'
            ? document.querySelector('.meeting-empty h3')?.textContent === '尚未接入数据源'
            : document.querySelector('.meeting-row-main');
          if (!matched) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - started));
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const select = document.querySelector('select[aria-label="会议范围"]');
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }), i % 2 === 0 ? '客户' : '机房');
      filterSamples.push(sample);
    }
    const frames = samples.map((item) => item.frameMs).sort((a, b) => a - b);
    const evidence = {
      kind: 'DOM-click-to-commit-and-next-frame',
      mode: process.env.MEETING_BROWSER_MODE || 'development',
      samples,
      p95: frames[Math.ceil(frames.length * 0.95) - 1],
      filterSamples,
      filterP95: [...filterSamples].sort((a, b) => a - b)[Math.ceil(filterSamples.length * 0.95) - 1],
    };
    writeFileSync(
      resolve(
        __dirname,
        '../../output/meeting-management-validation/performance-proof.json',
      ),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence));
    assert(evidence.p95 <= 150, `缓存详情 P95 ${evidence.p95} ms 超过 150 ms`);
    assert(evidence.filterP95 <= 100, `分类切换 P95 ${evidence.filterP95} ms 超过 100 ms`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

