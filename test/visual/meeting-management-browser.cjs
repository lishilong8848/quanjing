const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const output = resolve(__dirname, '../../output/meeting-management-validation');
mkdirSync(output, { recursive: true });
const api = 'http://127.0.0.1:4201';
const ui = 'http://127.0.0.1:4200';
const evidence = { checks: [], timings: {}, requests: [], pageErrors: [] };
let browser;
const control = async (mode = 'normal', role = 'admin') => {
  const res = await fetch(`${api}/__qa/control?mode=${mode}&role=${role}`);
  assert(res.ok);
};
const check = (name) => evidence.checks.push(name);

async function observeLocalFeedback(page, event, selector, expectedText) {
  await page.evaluate(
    ({ event, selector, expectedText }) => {
      window.__meetingLocalMs = null;
      let started;
      document.addEventListener(
        event,
        () => {
          started = performance.now();
        },
        { capture: true, once: true },
      );
      const observer = new MutationObserver(() => {
        const target = document.querySelector(selector);
        if (
          started !== undefined &&
          target &&
          (!expectedText || target.textContent.includes(expectedText))
        ) {
          observer.disconnect();
          requestAnimationFrame(() => {
            window.__meetingLocalMs = performance.now() - started;
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    },
    { event, selector, expectedText },
  );
}

async function localTiming(page) {
  await page.waitForFunction(() => typeof window.__meetingLocalMs === 'number');
  return page.evaluate(() => window.__meetingLocalMs);
}

async function main() {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/meeting-management/'))
      evidence.requests.push(new URL(request.url()).pathname);
  });
  await control();
  await page.goto(`${ui}/meeting-management/history`);
  await page.locator('.meeting-list li').first().waitFor();
  await page.locator('.meeting-sync').waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('.meeting-metric strong').first().textContent(),
    '41',
  );
  assert.equal(await page.locator('.meeting-list li').count(), 20);
  assert.equal(
    await page
      .locator('.meeting-page-nav a[aria-current="page"]')
      .textContent(),
    '历史会议',
  );
  await page.screenshot({
    path: resolve(output, 'desktop.png'),
    fullPage: true,
  });
  check('桌面真实数据、指标、每页20条、知识交付入口');
  await page.getByRole('button', { name: '知识交付', exact: true }).click();
  await page
    .getByRole('button', { name: /议事航迹/ })
    .first()
    .waitFor();
  await page.keyboard.press('Escape');

  const initialRequests = evidence.requests.length;
  await page.getByLabel('会议范围', { exact: true }).selectOption('客户');
  await page.getByRole('heading', { name: '尚未接入数据源' }).waitFor();
  await page.getByLabel('会议范围', { exact: true }).selectOption('机房');
  await page.getByLabel('会议性质', { exact: true }).selectOption('培训类');
  await page.getByRole('heading', { name: '尚未接入数据源' }).waitFor();
  await page.getByLabel('会议性质', { exact: true }).selectOption('管理类');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.getByLabel('下一页', { exact: true }).click();
  await page
    .locator('.meeting-pagination')
    .filter({ hasText: '第 2 / 3 页' })
    .waitFor();
  await page.getByLabel('上一页', { exact: true }).click();
  await page
    .getByPlaceholder('搜索周次、内容或待办')
    .fill('根本不存在的会议验收');
  await page.getByRole('heading', { name: '没有符合条件的记录' }).waitFor();
  await page.getByPlaceholder('搜索周次、内容或待办').fill('');
  await page.locator('.meeting-list li').first().waitFor();
  assert.equal(evidence.requests.length, initialRequests);
  check('分类、性质、关键词、分页均无额外请求');

  const first = page.locator('.meeting-row-main').first();
  const firstTitle = await first.locator('strong').textContent();
  await first.click();
  await page.locator('.meeting-content-section').first().waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('heading', { level: 2 })
      .textContent(),
    firstTitle,
  );
  const documentLink = page.getByRole('link', { name: '打开原始周报' });
  if (await documentLink.count())
    assert.match(
      await documentLink.getAttribute('href'),
      /^https:\/\/vnet\.feishu\.cn\/docx\//,
    );
  const sectionButtons = page.locator('.meeting-section-nav button');
  if (await sectionButtons.count()) {
    assert.equal(await page.locator('.meeting-content-section').count(), 1);
    await sectionButtons.last().click();
    assert.equal(await page.locator('.meeting-content-section').count(), 1);
    await page.getByRole('button', { name: '全部内容', exact: true }).click();
    assert.equal(await page.locator('.meeting-content-section').count(), (await sectionButtons.count()) - 1);
    await sectionButtons.nth(1).click();
  }
  await page.screenshot({ path: resolve(output, 'detail-desktop.png') });
  await page.getByLabel('关闭', { exact: true }).click();
  const requestsAfterDetail = evidence.requests.length;
  await observeLocalFeedback(page, 'click', '.meeting-detail');
  await first.click();
  await page.locator('.meeting-content-section').first().waitFor();
  evidence.timings.cachedDialogLocalMs = await localTiming(page);
  assert(evidence.timings.cachedDialogLocalMs <= 150);
  assert.equal(evidence.requests.length, requestsAfterDetail);
  await page.getByLabel('关闭', { exact: true }).click();
  check('真实详情正文与原始周报链接、重复下钻命中缓存');

  await control('detail-delay');
  const second = page.locator('.meeting-row-main').nth(1);
  const secondTitle = await second.locator('strong').textContent();
  const start = Date.now();
  await observeLocalFeedback(page, 'click', '.meeting-detail');
  await second.click();
  await page.getByRole('dialog').waitFor();
  evidence.timings.dialogVisibleMs = Date.now() - start;
  evidence.timings.dialogLocalMs = await localTiming(page);
  assert(evidence.timings.dialogLocalMs <= 100);
  assert(evidence.timings.dialogVisibleMs < 500);
  await page
    .getByRole('status')
    .filter({ hasText: '正在读取会议内容' })
    .waitFor();
  await page.getByLabel('关闭', { exact: true }).click();
  await first.click();
  await page.locator('.meeting-content-section').first().waitFor();
  await page.waitForTimeout(1800);
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('heading', { level: 2 })
      .textContent(),
    firstTitle,
  );
  await page.getByLabel('关闭', { exact: true }).click();
  check('打开立即反馈、关闭后旧响应不覆盖其他记录');

  await control('detail-fail');
  await second.click();
  await page
    .getByRole('alert')
    .filter({ hasText: '验收模拟会议内容读取失败' })
    .waitFor();
  await control();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '重新加载' })
    .click();
  await page.locator('.meeting-detail-footer').waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('heading', { level: 2 })
      .textContent(),
    secondTitle,
  );
  await page.getByLabel('关闭', { exact: true }).click();
  check('详情失败可重试');

  await control('detail-timeout');
  await page.locator('.meeting-row-main').nth(2).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '加载超时' })
    .waitFor({ timeout: 19000 });
  assert.equal(await page.locator('.meeting-detail .animate-spin').count(), 0);
  await page.getByLabel('关闭', { exact: true }).click();
  check('详情超时结束转圈并可关闭');

  await control('snapshot-fail');
  await page.getByLabel('刷新数据', { exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '验收模拟归档连接失败' })
    .waitFor();
  assert.equal(await page.locator('.meeting-list li').count(), 20);
  await control();
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  check('归档刷新失败保留历史列表，恢复后可刷新');

  await page.getByRole('link', { name: '南通属地周会', exact: true }).click();
  await page
    .locator('.meeting-page-nav a[aria-current="page"]')
    .filter({ hasText: '南通属地周会' })
    .waitFor();
  assert.equal(
    await page.getByLabel('会议范围', { exact: true }).inputValue(),
    '机房',
  );
  assert(await page.getByLabel('会议范围', { exact: true }).isDisabled());
  check('属地周会独立二级路由');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, 'mobile.png'),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.locator('.meeting-row-main').first().click();
  await page.locator('.meeting-detail-footer').waitFor();
  assert(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  assert(await page.getByLabel('关闭', { exact: true }).isVisible());
  await page.screenshot({ path: resolve(output, 'detail-mobile.png') });
  await page.getByLabel('关闭', { exact: true }).click();
  check('手机页面与详情无横向溢出、关闭与正文可见');

  await control('large');
  await page.goto(`${ui}/meeting-management/history`);
  await page
    .locator('.meeting-metric strong')
    .filter({ hasText: '10000' })
    .waitFor();
  assert.equal(await page.locator('.meeting-list li').count(), 20);
  const beforeSearch = evidence.requests.length;
  const searchStart = Date.now();
  await observeLocalFeedback(
    page,
    'input',
    '.meeting-row-main strong',
    '验收周报9999',
  );
  await page.getByPlaceholder('搜索周次、内容或待办').fill('验收周报9999');
  await page
    .locator('.meeting-row-main strong')
    .filter({ hasText: /^验收周报9999$/ })
    .waitFor();
  evidence.timings.largeSearchMs = Date.now() - searchStart;
  evidence.timings.largeSearchLocalMs = await localTiming(page);
  assert(evidence.timings.largeSearchLocalMs < 200);
  assert.equal(evidence.requests.length, beforeSearch);
  check('10000条代表性数据本地搜索、每页20条、零请求');

  await control('normal', 'guest');
  await page.goto(`${ui}/meeting-management/history`);
  await page
    .getByRole('alert')
    .filter({ hasText: '无会议归档访问权限' })
    .waitFor();
  const forbidden = await fetch(`${api}/api/meeting-management/snapshot`, {
    headers: { 'x-qa-role': 'guest' },
  });
  assert.equal(forbidden.status, 403);
  const editor = await fetch(`${api}/api/meeting-management/snapshot`, {
    headers: { 'x-qa-role': 'editor' },
  });
  assert.equal(editor.status, 200);
  check('游客前后端拒绝，编辑角色可读');
  await control();
  assert.deepEqual(evidence.pageErrors, []);
  check('无浏览器运行错误');
}

main()
  .then(() => {
    writeFileSync(
      resolve(output, 'browser-proof.json'),
      JSON.stringify({ ...evidence, passed: true }, null, 2),
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks: evidence.checks,
        timings: evidence.timings,
        apiRequests: evidence.requests.length,
      }),
    );
  })
  .catch((error) => {
    writeFileSync(
      resolve(output, 'browser-proof.json'),
      JSON.stringify(
        { ...evidence, passed: false, error: error.message },
        null,
        2,
      ),
    );
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
  });

