const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = 'http://127.0.0.1:4203';
const api = 'http://127.0.0.1:4202';
const out = path.resolve('output/meeting-sources-validation');
const proof = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  errors: [],
  localFeedbackMs: [],
};
const check = (name) => {
  proof.checks.push(name);
  console.log(name);
};
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await fetch(`${api}/__qa/control?mode=normal&role=admin`);
    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    const data = await (
      await fetch(`${api}/api/meeting-management/snapshot`)
    ).json();
    proof.counts = data.sources.map((s) => ({
      source: s.source,
      count: s.count,
      state: s.state,
    }));
    assert.deepEqual(
      proof.counts.map((s) => s.count),
      [41, 16, 111],
    );
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
    });
    page.on('pageerror', (e) => proof.errors.push(e.message));
    let reads = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/meeting-management/')) reads++;
    });
    await page.goto(`${root}/meeting-management`);
    await page.getByText('真实数据', { exact: true }).waitFor();
    await page
      .locator('.meeting-source-summary-number')
      .first()
      .getByText('41', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('.meeting-metric')
        .first()
        .locator('strong')
        .textContent(),
      '168条',
    );
    assert.equal(await page.locator('.meeting-source-summary').count(), 3);
    assert.equal(await page.getByText('演示数据', { exact: true }).count(), 0);
    const panels = await page
      .locator('.meeting-overview-charts > .meeting-analysis-panel')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().height),
      );
    assert(Math.abs(panels[0] - panels[1]) < 2);
    await page.screenshot({
      path: path.join(out, 'overview-desktop.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '查看培训分享记录', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByText('16 条记录', { exact: true })
      .waitFor();
    await page
      .getByRole('dialog')
      .locator('.meeting-demo-drill-list button')
      .first()
      .click();
    await page
      .getByRole('dialog')
      .getByText('分享人', { exact: true })
      .waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    check('真实168条汇总、三来源卡片、同排图表等高、分类下钻到真实详情');
    await page
      .locator('.meeting-page-nav')
      .getByRole('link', { name: '培训分享', exact: true })
      .click();
    await page.locator('.meeting-training-card').first().waitFor();
    assert.equal(await page.locator('.meeting-training-card').count(), 12);
    const before = reads;
    const start = Date.now();
    await page
      .getByLabel('板块类型', { exact: true })
      .selectOption('故障案例分析');
    await page.waitForFunction(
      () => document.querySelectorAll('.meeting-training-card').length === 2,
    );
    proof.localFeedbackMs.push(Date.now() - start);
    assert.equal(reads, before);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    const presenter = data.records.find(
      (r) => r.source === 'training' && r.presenters?.length,
    )?.presenters[0];
    await page.getByLabel('分享人', { exact: true }).selectOption(presenter.id);
    assert(
      (
        await page.locator('.meeting-training-person strong').allTextContents()
      ).every((v) => v.includes(presenter.name)),
    );
    await page.getByRole('button', { name: '重置', exact: true }).click();
    assert(
      (
        await page
          .locator('.meeting-resource-links a')
          .evaluateAll((nodes) => nodes.map((n) => n.href))
      ).every((url) => /^https:\/\/[^/]+\.feishu\.cn\//.test(url)),
    );
    await page.screenshot({
      path: path.join(out, 'training-desktop.png'),
      fullPage: true,
    });
    check('培训类型/人员本地筛选、12条分页、课件与回放入口');
    await page
      .locator('.meeting-page-nav')
      .getByRole('link', { name: '阿里会议', exact: true })
      .click();
    await page.locator('.meeting-ali-row').first().waitFor();
    assert.equal(await page.locator('.meeting-ali-row').count(), 20);
    await page
      .getByLabel('板块类型', { exact: true })
      .selectOption('阿里周例会');
    assert(
      (
        await page
          .locator('.meeting-source-record-meta [data-slot="badge"]')
          .allTextContents()
      )
        .filter((v) => v !== '客户')
        .every((v) => v === '阿里周例会'),
    );
    await page
      .locator('.meeting-archive-heading')
      .getByText('38 条记录', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.screenshot({
      path: path.join(out, 'ali-desktop.png'),
      fullPage: true,
    });
    const damaged = data.records.find(
      (r) =>
        r.source === 'ali-meeting' &&
        r.warnings?.some((w) => w.includes('乱码')),
    );
    await page.goto(
      `${root}/meeting-management/ali-meetings?record=${encodeURIComponent(damaged.id)}`,
    );
    await page
      .getByRole('dialog')
      .getByText('源表会议重点含乱码，请查看原始纪要', { exact: true })
      .waitFor();
    assert.equal(await page.locator('.meeting-content-text').count(), 0);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    check('阿里111条按6类型筛选、20条分页、乱码提示不伪造正文');
    await page
      .locator('.meeting-page-nav')
      .getByRole('link', { name: '历史会议', exact: true })
      .click();
    await page.getByLabel('会议来源', { exact: true }).selectOption('training');
    await page
      .locator('.meeting-archive-heading')
      .getByText('16 条归档记录', { exact: true })
      .waitFor();
    await page
      .locator('.meeting-page-nav')
      .getByRole('link', { name: '南通属地周会', exact: true })
      .click();
    await page
      .locator('.meeting-archive-heading')
      .getByText('41 条归档记录', { exact: true })
      .waitFor();
    await page.getByLabel('目标周报').waitFor();
    assert.equal(
      await page.getByLabel('目标周报').locator('option[value^="rec"]').count(),
      41,
    );
    check('统一历史来源过滤、周会清单与生成目标保持41条隔离');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [route, selector] of [
      ['', '.meeting-source-summary'],
      ['/training', '.meeting-training-card'],
      ['/ali-meetings', '.meeting-ali-row'],
    ]) {
      await page.goto(`${root}/meeting-management${route}`);
      await page.locator(selector).first().waitFor();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 2,
        ),
        route || 'overview',
      );
      await page.screenshot({
        path: path.join(
          out,
          `mobile-${route.replace('/', '') || 'overview'}.png`,
        ),
        fullPage: true,
      });
      if (route) {
        await page.locator('.meeting-source-title').first().click();
        await page
          .getByRole('dialog')
          .locator('.meeting-source-detail')
          .waitFor();
        assert(
          await page
            .getByRole('dialog')
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 2),
        );
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '关闭', exact: true })
          .click();
      }
    }
    check('390px总览/培训/阿里及详情无横向溢出');
    await fetch(`${api}/__qa/control?mode=detail-fail&role=admin`);
    await page.locator('.meeting-source-title').nth(1).click();
    await page
      .getByRole('dialog')
      .getByText('验收模拟会议内容读取失败，请重试')
      .waitFor();
    await fetch(`${api}/__qa/control?mode=normal&role=admin`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '重新加载', exact: true })
      .click();
    await page.getByRole('dialog').locator('.meeting-source-detail').waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await fetch(`${api}/__qa/control?mode=normal&role=guest`);
    await page.reload();
    await page
      .getByText('当前账号无会议归档访问权限', { exact: true })
      .waitFor();
    check('详情失败可重试、游客不能读取归档');
    assert.deepEqual(proof.errors, []);
    proof.passed = true;
  } finally {
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(out, 'browser-proof.json'),
      JSON.stringify(proof, null, 2),
    );
    await fetch(`${api}/__qa/control?mode=normal&role=admin`);
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
