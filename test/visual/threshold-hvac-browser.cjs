const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chromium,
} = require('C:/Users/36056/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
const seed = require('../../shared/hvac-thresholds.seed.json');
const expectedCount =
  seed.records.length +
  require('../../shared/electrical-thresholds.seed.json').records.length;
const output = process.env.THRESHOLD_EVIDENCE_ROOT;
if (!output) throw new Error('THRESHOLD_EVIDENCE_ROOT required');
const results = [];
const api = async (url, options) => {
  const response = await fetch(`http://127.0.0.1:4191${url}`, options);
  return { status: response.status, body: await response.json() };
};
const count = async () =>
  (await api('/api/threshold-management/records')).body.records.length;
const control = (mode = 'normal', role = 'admin') =>
  api(`/__qa/control?mode=${mode}&role=${role}`);
const measure = (page) =>
  page.evaluate(() => {
    const a = document
      .querySelector('.threshold-device-rail')
      .getBoundingClientRect();
    const b = document
      .querySelector('.threshold-sheet')
      .getBoundingClientRect();
    return {
      width: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      topDifference: a.top - b.top,
      bottomDifference: a.bottom - b.bottom,
      professionWidths: [
        ...document.querySelectorAll('.threshold-professions button'),
      ].map((x) => x.getBoundingClientRect().width),
    };
  });
async function main() {
  fs.mkdirSync(output, { recursive: true });
  await control();
  assert.equal(await count(), expectedCount);
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      'C:/Users/36056/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mutations = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().includes('threshold-management')
    )
      mutations.push(request.postDataJSON());
  });
  const search = page.getByRole('textbox', {
    name: '搜索设备、参数、位置或设定值',
  });
  const detail = () => page.getByRole('dialog');
  const coldButton = () =>
    page.getByRole('button', { name: /^查看D楼.*冷冻水出水温度$/ });
  try {
    await page.goto('http://127.0.0.1:4190/threshold-management');
    await page.getByRole('button', { name: '暖通', exact: true }).click();
    await page
      .getByRole('button', { name: '冷水机组 1064', exact: true })
      .waitFor();
    await coldButton().waitFor();
    const desktop = await measure(page);
    assert.equal(desktop.topDifference, 0);
    assert.equal(desktop.bottomDifference, 0);
    assert.equal(desktop.pageWidth, desktop.width);
    await page.screenshot({
      path: path.join(output, 'threshold-hvac-desktop.png'),
    });
    results.push({ name: '暖通桌面对齐', ...desktop });
    for (const [sheet, amount] of Object.entries(seed.audit.counts)) {
      const device = sheet.replace(/^\d+-/, '');
      await page
        .getByRole('button', { name: `${device} ${amount}`, exact: true })
        .click();
      await page
        .locator('.threshold-sheet')
        .getByText(`${amount.toLocaleString()} 个设定值`, { exact: true })
        .waitFor();
    }
    results.push({ name: '12类设备全部可访问', count: 12 });
    const latencies = { profession: [], detail: [] };
    const sample = async (kind, action) => {
      await page.evaluate((kind) => {
        window.thresholdQaLatency = undefined;
        document.addEventListener(
          'click',
          (event) => {
            const clicked = event.target.closest('button');
            const started = performance.now();
            const observer = new MutationObserver(() => {
              const ready =
                kind === 'detail'
                  ? document.querySelector('[role="dialog"]')
                  : clicked?.getAttribute('aria-pressed') === 'true';
              if (!ready) return;
              observer.disconnect();
              requestAnimationFrame(() => {
                window.thresholdQaLatency = performance.now() - started;
              });
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              attributes: true,
            });
          },
          { capture: true, once: true },
        );
      }, kind);
      await action();
      await page.waitForFunction(
        () => typeof window.thresholdQaLatency === 'number',
      );
      latencies[kind].push(
        await page.evaluate(() => window.thresholdQaLatency),
      );
    };
    for (let i = 0; i < 20; i++) {
      const name = i % 2 === 0 ? '电气' : '暖通';
      await sample('profession', () =>
        page.getByRole('button', { name, exact: true }).click(),
      );
    }
    await coldButton().click();
    await detail().waitFor();
    await detail().getByRole('button', { name: '关闭', exact: true }).click();
    for (let i = 0; i < 20; i++) {
      await sample('detail', () => coldButton().click());
      await detail().getByRole('button', { name: '关闭', exact: true }).click();
    }
    const p95 = (values) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    const professionP95 = p95(latencies.profession);
    const detailP95 = p95(latencies.detail);
    assert(professionP95 <= 100, `专业切换P95 ${professionP95}`);
    assert(detailP95 <= 150, `缓存详情P95 ${detailP95}`);
    results.push({
      name: `${expectedCount}条生产模式隔离入口性能`,
      professionP95,
      detailP95,
      samples: latencies,
    });
    await page.getByRole('button', { name: '蓄冷罐 240', exact: true }).click();
    await page.getByText('24 项参数 · 240 个设定值', { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('.threshold-matrix-row')
        .filter({ hasText: '放冷时间' })
        .locator('.is-different')
        .count(),
      0,
    );
    await page.screenshot({
      path: path.join(output, 'threshold-hvac-tank.png'),
    });
    results.push({ name: '蓄冷罐24参数10区域', pass: true });
    await page
      .getByRole('button', { name: '冷水机组 1064', exact: true })
      .click();
    await search.fill('冷冻水出水温度');
    await coldButton().click();
    await detail().getByText('17.5℃', { exact: true }).first().waitFor();
    await detail().getByText('17-18摄氏度', { exact: true }).waitFor();
    await detail().getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('运行范围', { exact: true }).fill('17-19℃');
    await page.getByLabel('设定值', { exact: true }).fill('18.1℃');
    await control('fail');
    await detail().getByRole('button', { name: '保存', exact: true }).click();
    await detail().getByRole('alert').waitFor();
    assert.equal(
      await page.getByLabel('设定值', { exact: true }).inputValue(),
      '18.1℃',
    );
    assert.equal(
      await page.getByLabel('运行范围', { exact: true }).inputValue(),
      '17-19℃',
    );
    const original = seed.records.find(
      (r) => r.source.sheet === '01-冷水机组' && r.source.cell === 'O7',
    );
    const snapshot = (await api('/api/threshold-management/records')).body;
    assert.equal(
      snapshot.records.find((r) => r.id === original.id).value,
      original.value,
    );
    await control('delay');
    await detail().getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('同步中', { exact: true }).first().waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.threshold-cell-value[disabled]'),
    );
    await coldButton().click();
    await detail().getByText('18.1℃', { exact: true }).first().waitFor();
    await detail().getByText('17-19℃', { exact: true }).waitFor();
    await detail().getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('设定值', { exact: true }).fill(original.value);
    await page.getByLabel('运行范围', { exact: true }).fill(original.range);
    await detail().getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.threshold-cell-value[disabled]'),
    );
    results.push({
      name: '真实暖通阈值修改/失败草稿恢复/延时重试/原值恢复',
      pass: true,
    });
    await search.fill('');
    await page.getByRole('button', { name: '新增阈值', exact: true }).click();
    await page
      .getByLabel('参数 *', { exact: true })
      .fill('QA-暖通闭环-20261008');
    await page.getByLabel('楼栋', { exact: true }).selectOption('A楼');
    await page.getByLabel('位置 / 型号', { exact: true }).fill('验收型号');
    await page.getByLabel('设定值', { exact: true }).fill('0');
    await page.getByLabel('运行范围', { exact: true }).fill('0-50');
    await control('timeout');
    const before = mutations.length;
    await detail()
      .getByRole('button', { name: '保存', exact: true })
      .dblclick();
    await search.fill('QA-暖通闭环-20261008');
    await page.getByText('同步中', { exact: true }).first().waitFor();
    await detail()
      .getByRole('button', { name: '重试保存', exact: true })
      .waitFor({ timeout: 20000 });
    assert.equal(
      await page.getByLabel('设定值', { exact: true }).inputValue(),
      '0',
    );
    assert.equal(
      await page.getByLabel('运行范围', { exact: true }).inputValue(),
      '0-50',
    );
    assert.equal(mutations.length - before, 1);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const late = (
      await api('/api/threshold-management/records')
    ).body.records.filter((r) => r.parameter === 'QA-暖通闭环-20261008');
    assert.equal(late.length, 1);
    assert.equal(late[0].range, '0-50');
    await detail()
      .getByRole('button', { name: '重试保存', exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector('.threshold-cell-value[disabled]'),
    );
    assert.equal(mutations.length - before, 2);
    assert.equal(
      mutations[before].clientMutationId,
      mutations[before + 1].clientMutationId,
    );
    results.push({
      name: '15秒超时/17秒迟到落盘/同标识重试不重复',
      pass: true,
    });
    const qaButton = page.getByRole('button', {
      name: /^查看A楼.*QA-暖通闭环-20261008$/,
    });
    await qaButton.click();
    await detail().getByText('0-50', { exact: true }).waitFor();
    await detail().getByRole('button', { name: '删除', exact: true }).click();
    await detail().getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('暂无匹配参数', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '暖通', exact: true }).click();
    assert.equal(await count(), expectedCount);
    const after = (await api('/api/threshold-management/records')).body.records;
    assert(!after.some((r) => r.parameter === 'QA-暖通闭环-20261008'));
    assert.equal(after.find((r) => r.id === original.id).value, original.value);
    assert.equal(after.find((r) => r.id === original.id).range, original.range);
    results.push({
      name: '新增零值/范围/双击幂等/删除/刷新持久化',
      pass: true,
      requests: mutations.length,
    });
    await page.getByRole('button', { name: '电气', exact: true }).click();
    await page.getByRole('button', { name: 'UPS 410', exact: true }).click();
    await page
      .locator('.threshold-sheet')
      .getByText('410 个设定值', { exact: true })
      .waitFor();
    results.push({ name: '电气UPS回归', pass: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '暖通', exact: true }).click();
    await page
      .getByRole('button', { name: '依米康风冷空调', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: '手机位置或型号' })
      .selectOption({ label: 'SCAL502UES' });
    await page.screenshot({
      path: path.join(output, 'threshold-hvac-mobile.png'),
    });
    const mobile = await measure(page);
    assert.equal(mobile.pageWidth, 390);
    results.push({ name: '手机两型号切换/无整页溢出', ...mobile });
    await control('normal', 'editor');
    await page.reload();
    await page.getByRole('button', { name: '暖通', exact: true }).click();
    await page
      .getByRole('button', { name: /^查看A楼.*冷冻水出水温度$/ })
      .click();
    assert.equal(
      await detail().getByRole('button', { name: '删除', exact: true }).count(),
      0,
    );
    await control('normal', 'guest');
    await page.reload();
    await page.getByText('当前账号无阈值管理权限', { exact: true }).waitFor();
    assert.equal(
      (
        await api('/api/threshold-management/records', {
          headers: { 'x-qa-role': 'guest' },
        })
      ).status,
      403,
    );
    results.push({ name: '编辑员禁止删除/游客禁止读写', pass: true });
    assert.equal(errors.length, 0);
    results.push({ name: 'pageerror', count: errors.length });
  } catch (error) {
    await page.screenshot({
      path: path.join(output, 'threshold-hvac-failure.png'),
    });
    results.push({ name: 'failure', message: error.message });
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, 'threshold-hvac-browser-evidence.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          mode: process.env.THRESHOLD_BROWSER_MODE,
          results,
          mutationOperations: mutations.map((r) => ({
            operation: r.operation,
            clientMutationId: r.clientMutationId,
          })),
          errors,
        },
        null,
        2,
      ),
    );
    await browser.close();
    await control();
  }
  console.log(JSON.stringify(results));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
