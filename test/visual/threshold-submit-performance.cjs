const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const expectedCount =
  require('../../shared/electrical-thresholds.seed.json').records.length +
  require('../../shared/hvac-thresholds.seed.json').records.length;
const {
  chromium,
} = require('C:/Users/36056/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      'C:/Users/36056/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  });
  try {
    await fetch('http://127.0.0.1:4191/__qa/control?role=admin');
    const existing = await (
      await fetch('http://127.0.0.1:4191/api/threshold-management/records')
    ).json();
    for (const record of existing.records.filter(
      (r) =>
        r.parameter === 'QA-暖通反馈-20261008' &&
        r.profession === '暖通' &&
        r.source === null,
    )) {
      await fetch('http://127.0.0.1:4191/api/threshold-management/mutations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'delete',
          clientMutationId: 'qa-feedback-cleanup-' + record.id,
          id: record.id,
          expectedVersion: record.version,
        }),
      });
    }
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto('http://127.0.0.1:4190/threshold-management');
    await page.getByRole('button', { name: '暖通', exact: true }).click();
    await page.getByRole('button', { name: '新增阈值', exact: true }).click();
    await page
      .getByLabel('参数 *', { exact: true })
      .fill('QA-暖通反馈-20261008');
    await page.getByLabel('楼栋', { exact: true }).selectOption('A楼');
    await page.getByLabel('设定值', { exact: true }).fill('0');
    await page.getByLabel('运行范围', { exact: true }).fill('0-1');
    await fetch('http://127.0.0.1:4191/__qa/control?mode=delay');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const baseline = (await cdp.send('Performance.getMetrics')).metrics;
    await page.evaluate(() =>
      document.addEventListener(
        'click',
        () => {
          window.thresholdSubmitStart = performance.now();
          const observer = new MutationObserver(() => {
            if (!document.querySelector('.threshold-matrix-cell.is-syncing'))
              return;
            observer.disconnect();
            window.thresholdSubmitDomMs =
              performance.now() - window.thresholdSubmitStart;
            requestAnimationFrame(
              () =>
                (window.thresholdSubmitMs =
                  performance.now() - window.thresholdSubmitStart),
            );
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          });
        },
        { once: true, capture: true },
      ),
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await page.waitForFunction(
      () => typeof window.thresholdSubmitMs === 'number',
    );
    const ms = await page.evaluate(() => window.thresholdSubmitMs);
    const metrics = (await cdp.send('Performance.getMetrics')).metrics;
    const domMs = await page.evaluate(() => window.thresholdSubmitDomMs);
    const phases = Object.fromEntries(
      [
        'TaskDuration',
        'ScriptDuration',
        'LayoutDuration',
        'RecalcStyleDuration',
      ].map((name) => [
        name,
        (metrics.find((m) => m.name === name).value -
          baseline.find((m) => m.name === name).value) *
          1000,
      ]),
    );
    const experiment = {
      measuredAt: new Date().toISOString(),
      optimisticFeedbackMs: ms,
      domMs,
      phases,
    };
    const experimentPath = path.join(
      process.env.THRESHOLD_EVIDENCE_ROOT,
      'threshold-submit-experiments.json',
    );
    const experiments = fs.existsSync(experimentPath)
      ? JSON.parse(fs.readFileSync(experimentPath, 'utf8'))
      : [{ optimisticFeedbackMs: 251.2, instrumented: false }];
    experiments.push(experiment);
    fs.writeFileSync(experimentPath, JSON.stringify(experiments, null, 2));
    console.log(JSON.stringify(experiment));
    assert(ms <= 150, `提交反馈 ${ms}ms`);
    await page.waitForFunction(
      () => !document.querySelector('.threshold-matrix-cell.is-syncing'),
    );
    const requestStartMs = await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .find((x) => x.name.includes('/threshold-management/mutations'))
          .startTime - window.thresholdSubmitStart,
    );
    assert(requestStartMs <= 150);
    await page
      .getByRole('button', { name: /^查看A楼.*QA-暖通反馈-20261008$/ })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page.waitForFunction(
      () => !document.body.textContent.includes('QA-暖通反馈-20261008'),
    );
    const snapshot = await (
      await fetch('http://127.0.0.1:4191/api/threshold-management/records')
    ).json();
    assert.equal(snapshot.records.length, expectedCount);
    const proof = {
      mode: 'production-isolated-entry',
      dataCount: expectedCount,
      optimisticFeedbackMs: ms,
      requestStartMs,
      cleaned: true,
    };
    fs.writeFileSync(
      path.join(
        process.env.THRESHOLD_EVIDENCE_ROOT,
        'threshold-submit-performance.json',
      ),
      JSON.stringify(proof, null, 2),
    );
    console.log(JSON.stringify(proof));
  } finally {
    const snapshot = await (
      await fetch('http://127.0.0.1:4191/api/threshold-management/records')
    ).json();
    for (const record of snapshot.records.filter(
      (r) =>
        r.parameter === 'QA-暖通反馈-20261008' &&
        r.profession === '暖通' &&
        r.source === null,
    )) {
      const response = await fetch(
        'http://127.0.0.1:4191/api/threshold-management/mutations',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            operation: 'delete',
            clientMutationId: 'qa-feedback-cleanup-' + record.id,
            id: record.id,
            expectedVersion: record.version,
          }),
        },
      );
      assert.equal(response.status, 201);
    }
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
