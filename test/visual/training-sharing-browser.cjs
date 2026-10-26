const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const out = path.resolve('output/training-sharing-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const proof = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  errors: [],
  feedbackMs: [],
};
const check = (label) => {
  proof.checks.push(label);
  console.log(label);
};
const done = (row) => ['会议已结束', '会议评分中'].includes(row.status);
const known = (row) =>
  Number.isInteger(row.participantCount) && row.participantCount >= 0;
const sorted = (rows) =>
  [...rows].sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      (b.updatedAt || '').localeCompare(a.updatedAt || '') ||
      a.id.localeCompare(b.id),
  );
const expectedRanking = (rows, dimension) =>
  [
    ...new Map(
      rows
        .filter(done)
        .flatMap((r) => r.presenters || [])
        .map((p) => [p.id, p]),
    ).values(),
  ]
    .map((person) => {
      const shares = rows
        .filter(done)
        .filter((r) => r.presenters?.some((p) => p.id === person.id));
      const attended = shares.filter(known);
      return {
        person,
        shares: shares.length,
        participants: attended.length
          ? attended.reduce((total, r) => total + r.participantCount, 0)
          : null,
      };
    })
    .sort(
      (a, b) =>
        (b[dimension] ?? -1) - (a[dimension] ?? -1) ||
        b.shares - a.shares ||
        a.person.name.localeCompare(b.person.name, 'zh-CN') ||
        a.person.id.localeCompare(b.person.id),
    );
async function main() {
  const snapshot = await (
    await fetch('http://127.0.0.1:4201/api/meeting-management/snapshot')
  ).json();
  const rows = snapshot.records.filter((r) => r.source === 'training');
  const completed = rows.filter(done);
  const specialties = [
    ...new Set(
      rows
        .flatMap((r) => r.specialties || [])
        .filter((s) => !/(?:楼|栋)$/.test(s)),
    ),
  ];
  const people = new Set(
    rows.flatMap((r) => r.presenters || []).map((p) => p.id),
  );
  const expectedMetrics = [
    rows.length,
    completed.filter(known).reduce((sum, r) => sum + r.participantCount, 0),
    people.size,
    specialties.length,
  ];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
    });
    page.on('pageerror', (e) => proof.errors.push(e.message));
    let reads = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/meeting-management/snapshot')) reads++;
    });
    const metrics = (p) =>
      p
        .locator('.meeting-metric-content > div > strong')
        .evaluateAll((nodes) =>
          nodes.map((n) => Number(n.textContent.replace(/\D/g, ''))),
        );
    await page.goto('http://127.0.0.1:4200/meeting-management/training');
    await page.locator('.training-resource-row').first().waitFor();
    assert.deepEqual(await metrics(page), expectedMetrics);
    proof.metrics = {
      records: expectedMetrics[0],
      participantVisits: expectedMetrics[1],
      people: expectedMetrics[2],
      specialties: expectedMetrics[3],
      completed: completed.length,
    };
    assert.equal(await page.locator('.training-resource-row').count(), 10);
    assert.equal(await page.locator('.training-timeline-entry').count(), 6);
    const heights = await page
      .locator('.training-insight-grid > .meeting-analysis-panel')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().height),
      );
    assert(Math.abs(heights[0] - heights[1]) < 2);
    const timelineTitles = [];
    for (let i = 0; i < Math.ceil(rows.length / 6); i++) {
      timelineTitles.push(
        ...(await page
          .locator('.training-timeline-content > strong')
          .allTextContents()),
      );
      if (i < Math.ceil(rows.length / 6) - 1)
        await page
          .locator('.training-timeline-panel')
          .getByRole('button', { name: '下一页', exact: true })
          .click();
    }
    assert.deepEqual(
      timelineTitles,
      sorted(rows).map((r) => r.title),
    );
    check(
      '真实分享记录、参与人次、专业覆盖和分享人数一致；时间轴全量倒序、图表等高、分页有界',
    );
    const readsBefore = reads;
    for (const dimension of ['participants', 'shares']) {
      await page
        .getByRole('button', {
          name: dimension === 'participants' ? '参与人次' : '分享次数',
          exact: true,
        })
        .click();
      const expect = expectedRanking(rows, dimension);
      const names = [],
        values = [];
      for (let i = 0; i < Math.ceil(expect.length / 5); i++) {
        names.push(
          ...(await page
            .locator('.training-rank-person > strong')
            .allTextContents()),
        );
        values.push(
          ...(await page
            .locator('.training-rank-value > strong')
            .allTextContents()),
        );
        if (i < Math.ceil(expect.length / 5) - 1)
          await page
            .locator('.training-ranking-panel')
            .getByRole('button', { name: '下一页', exact: true })
            .click();
      }
      assert.deepEqual(
        names,
        expect.map((r) => r.person.name),
      );
      assert.deepEqual(
        values,
        expect.map((r) => String(r[dimension] ?? '—')),
      );
    }
    await page.getByRole('button', { name: '参与人次', exact: true }).click();
    const top = expectedRanking(rows, 'participants')[0];
    const trigger = page.getByRole('button', {
      name: `查看${top.person.name}的分享`,
      exact: true,
    });
    await trigger.click();
    await page
      .getByRole('dialog')
      .getByText(
        `${top.shares} 条分享记录 · ${top.shares} 次分享 · ${top.participants} 人次`,
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    assert.equal(
      await trigger.evaluate((n) => document.activeElement === n),
      true,
    );
    assert.equal(reads, readsBefore);
    check(
      '人气榜两种排序全量匹配；终止分享不参与排名；人员下钻本地打开并恢复焦点',
    );
    const groupLabels = await page
      .locator('.training-specialty-groups button > span:first-child > strong')
      .allTextContents();
    assert(groupLabels.every((label) => !/(?:楼|栋)$/.test(label)));
    for (const label of specialties) {
      const count = rows.filter((r) => r.specialties?.includes(label)).length;
      await page
        .getByRole('button', { name: `查看${label}分享`, exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByText(`${count} 条分享记录`, { exact: true })
        .waitFor();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    }
    for (const label of ['分享记录', '累计参与', '分享人', '专业覆盖']) {
      await page
        .getByRole('button', { name: `查看${label}`, exact: true })
        .click();
      assert(
        (await page
          .getByRole('dialog')
          .locator('.meeting-demo-drill-list section')
          .count()) <= 10,
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    }
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.getByLabel('楼栋专业', { exact: true }).selectOption('电气');
    assert.deepEqual(
      (await metrics(page))[0],
      rows.filter((r) => r.specialties?.includes('电气')).length,
    );
    await page
      .getByLabel('板块类型', { exact: true })
      .selectOption('故障案例分析');
    assert.equal(
      (await metrics(page))[0],
      rows.filter(
        (r) => r.specialties?.includes('电气') && r.subtype === '故障案例分析',
      ).length,
    );
    await page.getByRole('button', { name: '重置', exact: true }).click();
    const building = rows
      .flatMap((r) => r.specialties || [])
      .find((s) => /(?:楼|栋)$/.test(s));
    await page.getByLabel('培训楼栋', { exact: true }).selectOption(building);
    assert.equal(
      (await metrics(page))[0],
      rows.filter((r) => r.specialties?.includes(building)).length,
    );
    assert(
      (
        await page
          .locator(
            '.training-resource-content .meeting-source-record-meta > span:last-child',
          )
          .allTextContents()
      ).every((s) => s.includes(building)),
    );
    await page.getByRole('button', { name: '重置', exact: true }).click();
    const person = rows.find((r) => r.presenters?.length).presenters[0];
    await page.getByLabel('分享人', { exact: true }).selectOption(person.id);
    assert.equal(
      (await metrics(page))[0],
      rows.filter((r) => r.presenters?.some((p) => p.id === person.id)).length,
    );
    assert.equal(reads, readsBefore);
    await page
      .getByLabel('板块关键词', { exact: true })
      .fill('不存在的培训验收关键字');
    assert.deepEqual(await metrics(page), [0, 0, 0, 0]);
    await page
      .getByRole('button', { name: '查看分享记录', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByText('没有符合条件的分享记录', { exact: true })
      .waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '重置', exact: true }).click();
    check(
      '专业与楼栋分离；分组/四指标下钻匹配；组合筛选不重复读表，空集明确展示',
    );
    await page.locator('.training-timeline-entry').first().click();
    await page
      .getByRole('dialog')
      .getByText('分享人', { exact: true })
      .waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    const resourceTitles = await page
      .locator('.training-resource-content .meeting-source-title')
      .allTextContents();
    await page
      .locator('.training-resource-panel')
      .getByRole('button', { name: '下一页', exact: true })
      .click();
    resourceTitles.push(
      ...(await page
        .locator('.training-resource-content .meeting-source-title')
        .allTextContents()),
    );
    assert.deepEqual(
      resourceTitles,
      sorted(rows).map((r) => r.title),
    );
    assert(
      (
        await page
          .locator('.training-resource-actions a')
          .evaluateAll((nodes) => nodes.map((n) => n.href))
      ).every((href) => /^https:\/\/[^/]+\.feishu\.cn\//.test(href)),
    );
    await page
      .locator('.training-resource-panel')
      .getByRole('button', { name: '上一页', exact: true })
      .click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(out, 'training-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(out, 'training-mobile.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '查看累计参与', exact: true })
      .click();
    assert(
      await page
        .getByRole('dialog')
        .evaluate((n) => n.scrollWidth <= n.clientWidth + 2),
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    check(
      '时间轴可进入真实详情，资源全页无遗漏，课件回放入口保留；390px页面和下钻无横向溢出',
    );
    const synthetic = Array.from({ length: 1000 }, (_, i) => ({
      ...rows[0],
      id: `training:qa-${i}`,
      title: `长标题验收${i}：${'电气设备故障复盘与专业案例分享'.repeat(5)}`,
      date: i === 0 ? null : '2026-07-01',
      searchText: `验收${i} 电气`,
      participantCount: i % 3 ? null : 0,
      status: '会议已结束',
      presenters: [{ id: `qa-${i}`, name: `长姓名验收${i}分享人` }],
      specialties: i % 2 ? ['A楼', '电气'] : ['B楼', '消防'],
      resources: [],
    }));
    const fixture = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    fixture.on('pageerror', (e) => proof.errors.push(e.message));
    await fixture.route('**/api/meeting-management/snapshot**', (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          records: synthetic,
          sources: snapshot.sources.map((s) =>
            s.source === 'training'
              ? { ...s, count: 1000, state: 'ready', message: null }
              : s,
          ),
        },
      }),
    );
    await fixture.goto('http://127.0.0.1:4200/meeting-management/training');
    await fixture.locator('.training-resource-row').first().waitFor();
    assert.equal((await metrics(fixture))[0], 1000);
    assert.equal(await fixture.locator('.training-resource-row').count(), 10);
    assert.equal(await fixture.locator('.training-ranking li').count(), 5);
    assert.equal(await fixture.locator('.training-timeline-entry').count(), 6);
    assert(
      await fixture.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
    for (let i = 0; i < 12; i++) {
      proof.feedbackMs.push(
        await fixture.evaluate(async (index) => {
          const select = document.querySelector(
            'select[aria-label="楼栋专业"]',
          );
          const started = performance.now();
          select.value = index % 2 ? '电气' : '';
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return performance.now() - started;
        }, i),
      );
    }
    proof.filterP95Ms = [...proof.feedbackMs].sort((a, b) => a - b)[
      Math.ceil(proof.feedbackMs.length * 0.95) - 1
    ];
    assert(proof.filterP95Ms <= 100);
    check('1000条代表性输入有界渲染、长标题窄屏不溢出，本地筛选P95不超过100ms');
    await fixture.close();
    const errorPage = await browser.newPage();
    errorPage.on('pageerror', (e) => proof.errors.push(e.message));
    await errorPage.route('**/api/meeting-management/snapshot**', (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          records: [],
          sources: snapshot.sources.map((s) =>
            s.source === 'training'
              ? {
                  ...s,
                  count: null,
                  state: 'error',
                  message: '培训来源暂时不可用',
                }
              : s,
          ),
        },
      }),
    );
    await errorPage.goto('http://127.0.0.1:4200/meeting-management/training');
    await errorPage
      .locator('.training-resource-panel')
      .getByRole('alert')
      .waitFor();
    assert(
      (
        await errorPage
          .locator('.meeting-metric-content > div > strong')
          .allTextContents()
      ).every((v) => v.includes('—')),
    );
    assert(
      await errorPage
        .getByRole('button', { name: '查看分享记录', exact: true })
        .isDisabled(),
    );
    assert(
      (
        await errorPage
          .locator('.training-ranking-panel .meeting-panel-heading > span')
          .textContent()
      ).includes('—'),
    );
    await errorPage.close();
    const stalePage = await browser.newPage();
    stalePage.on('pageerror', (e) => proof.errors.push(e.message));
    await stalePage.route('**/api/meeting-management/snapshot**', (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          sources: snapshot.sources.map((s) =>
            s.source === 'training'
              ? { ...s, state: 'error', message: '后台刷新暂时失败' }
              : s,
          ),
        },
      }),
    );
    await stalePage.goto('http://127.0.0.1:4200/meeting-management/training');
    await stalePage.locator('.training-source-warning').waitFor();
    assert.deepEqual(await metrics(stalePage), expectedMetrics);
    await stalePage
      .getByRole('button', { name: '查看分享记录', exact: true })
      .click();
    await stalePage
      .getByRole('dialog')
      .getByRole('status')
      .getByText('当前展示最近一次成功同步的数据', { exact: true })
      .waitFor();
    await stalePage.close();
    check('来源失败显示错误和未知指标，不把读取失败伪装成零记录');
    await page.goto('http://127.0.0.1:4200/meeting-management/ali-meetings');
    await page.locator('.meeting-ali-row').first().waitFor();
    assert.equal(await page.locator('.meeting-ali-row').count(), 20);
    await page.getByLabel('板块类型', { exact: true }).selectOption('技术会议');
    assert.equal(
      await page.locator('.meeting-ali-row').count(),
      snapshot.records.filter(
        (r) => r.source === 'ali-meeting' && r.subtype === '技术会议',
      ).length,
    );
    assert.deepEqual(proof.errors, []);
    check('阿里会议原列表、分页与本地类型筛选保持可用；无浏览器异常');
    proof.passed = true;
  } finally {
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(out, 'browser-proof.json'),
      JSON.stringify(proof, null, 2),
    );
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
