const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(
  __dirname,
  '../../output/meeting-overview-validation',
);
fs.mkdirSync(output, { recursive: true });
const evidence = { checks: [], errors: [], requests: [], timings: {} };
const check = (name) => evidence.checks.push(name);
async function main() {
  await fetch('http://127.0.0.1:4201/__qa/control?mode=normal&role=admin');
  const source = await fetch(
    'http://127.0.0.1:4201/api/meeting-management/snapshot',
  ).then((r) => r.json());
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1040 },
    });
    page.on('pageerror', (error) => evidence.errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/api/meeting-management/'))
        evidence.requests.push(new URL(request.url()).pathname);
    });
    await page.goto('http://127.0.0.1:4200/meeting-management', {
      waitUntil: 'domcontentloaded',
    });
    await page
      .getByRole('heading', { name: '会议总览', exact: true })
      .waitFor();
    await page
      .locator('.meeting-connected-source')
      .filter({ hasText: `${source.records.length} 条` })
      .waitFor();
    assert.equal(
      await page
        .locator('.meeting-overview-metric strong')
        .first()
        .textContent(),
      '68场',
    );
    assert.equal(await page.locator('.meeting-scope-card').count(), 4);
    assert.equal(
      await page.locator('.meeting-trend-chart > button').count(),
      6,
    );
    assert.equal(
      await page
        .locator('.meeting-overview-toolbar .meeting-demo-badge')
        .textContent(),
      '演示数据',
    );
    assert.equal(await page.locator('.meeting-archive').count(), 0);
    await page.screenshot({
      path: path.join(output, 'overview-desktop.png'),
      fullPage: true,
    });
    check('首页总览、68场演示标记、四类画像、六个月趋势、真实周会独立入口');
    const initialRequests = evidence.requests.length;
    await page
      .getByRole('button', { name: '查看8月15场会议', exact: true })
      .click();
    await page.locator('.meeting-demo-dialog').waitFor();
    assert.equal(
      await page.locator('.meeting-demo-drill-list > section').count(),
      12,
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '下一页' })
      .click();
    assert.equal(
      await page.locator('.meeting-demo-drill-list > section').count(),
      3,
    );
    await page
      .locator('.meeting-demo-drill-list > section > button')
      .first()
      .click();
    await page.locator('.meeting-demo-content').waitFor();
    assert.match(
      await page.locator('.meeting-demo-content').textContent(),
      /责任组/,
    );
    await page.screenshot({ path: path.join(output, 'overview-drill.png') });
    await page.getByLabel('关闭', { exact: true }).click();
    check('趋势下钻汇总与15条明细一致、分页和示例事项展开');
    await page.getByLabel('总览月份', { exact: true }).selectOption('2026-10');
    await page.getByLabel('总览范围', { exact: true }).selectOption('客户');
    await page.getByLabel('总览性质', { exact: true }).selectOption('培训类');
    assert.equal(
      await page
        .locator('.meeting-overview-metric strong')
        .first()
        .textContent(),
      '0场',
    );
    await page.getByText('当前筛选下暂无议题', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page
      .getByRole('button', { name: '查看客户会议', exact: true })
      .click();
    await page.locator('.meeting-demo-dialog').waitFor();
    assert(
      (await page.locator('.meeting-demo-drill-list').textContent()).includes(
        '客户',
      ),
    );
    await page.getByLabel('关闭', { exact: true }).click();
    assert.equal(evidence.requests.length, initialRequests);
    check('月份/范围/性质交集、零结果、分类下钻与重置零额外请求');
    await page.getByRole('link', { name: '南通属地周会', exact: true }).click();
    await page.locator('.meeting-latest-actions').waitFor();
    await page.waitForFunction(() => scrollY === 0);
    assert.equal(
      await page.locator('.meeting-action-list li').count(),
      source.latestActions.items.length,
    );
    assert.match(
      await page.locator('.meeting-actions-heading').textContent(),
      new RegExp(source.latestActions.date),
    );
    assert.equal(
      await page.locator('.meeting-action-unassigned').count(),
      source.latestActions.items.filter((item) => !item.responsible).length,
    );
    assert(
      (await page.locator('.meeting-action-person').allTextContents()).some(
        (text) => text.includes('涉及人员'),
      ),
    );
    assert.match(
      await page.locator('.meeting-actions-toolbar').textContent(),
      /最新周报未填写待办/,
    );
    assert(await page.locator('.meeting-row-excerpt').first().isVisible());
    await page.screenshot({
      path: path.join(output, 'weekly-desktop.png'),
      fullPage: true,
    });
    await page.screenshot({ path: path.join(output, 'weekly-preview.png') });
    await page.locator('.meeting-action-source').first().click();
    await page.locator('.meeting-detail-footer').waitFor();
    assert.equal(
      await page
        .getByRole('dialog')
        .getByRole('heading', { level: 2 })
        .textContent(),
      source.latestActions.items[0].sourceTitle,
    );
    await page.getByLabel('关闭', { exact: true }).click();
    check(
      '最新真实待办、日期回溯提示、责任人与涉及人员分开、周报摘要及原记录下钻',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'weekly-mobile.png'),
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.getByRole('link', { name: '会议总览', exact: true }).click();
    await page.locator('.meeting-overview').waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(output, 'overview-mobile.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '查看客户会议', exact: true })
      .click();
    await page.locator('.meeting-demo-dialog').waitFor();
    assert(
      await page
        .getByRole('dialog')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await page.getByLabel('关闭', { exact: true }).click();
    check('手机总览、真实待办及演示下钻无横向溢出，关闭可见');
    await page.goto('http://127.0.0.1:4200/meeting-management/nantong-weekly');
    await page.locator('.meeting-action-source').first().waitFor();
    assert.equal(await page.locator('.meeting-action-source').count(), 6);
    check('属地周会二级链接直接打开与刷新成功');
    assert.deepEqual(evidence.errors, []);
    evidence.source = {
      latestDate: source.latestActions.date,
      actions: source.latestActions.items.length,
      records: source.records.length,
    };
    evidence.passed = true;
  } finally {
    await browser.close();
  }
}
main()
  .then(() => console.log(JSON.stringify(evidence)))
  .catch((error) => {
    evidence.passed = false;
    evidence.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() =>
    fs.writeFileSync(
      path.join(output, 'browser-proof.json'),
      JSON.stringify(evidence, null, 2),
    ),
  );
