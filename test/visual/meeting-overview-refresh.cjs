const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const out = path.resolve('output/meeting-overview-refresh-20261009');
fs.mkdirSync(out, { recursive: true });
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], errors: [] };
const check = name => { proof.checks.push(name); console.log(name); };
async function main() {
  const data = await (await fetch('http://127.0.0.1:4201/api/meeting-management/snapshot')).json();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', e => proof.errors.push(e.message));
    let reads = 0;
    page.on('request', r => { if (r.url().includes('/api/meeting-management')) reads++; });
    await page.goto('http://127.0.0.1:4200/meeting-management');
    await page.getByRole('button', { name: '查看会议动态', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.meeting-metric strong')?.textContent !== '—条');
    const labels = ['会议动态', '客户沟通', '专业研讨', '学习分享'];
    const expected = rows => [rows.length, rows.filter(r => r.scope === '客户').length, rows.filter(r => r.nature === '专业类').length, rows.filter(r => r.nature === '培训类').length];
    const values = () => page.locator('.meeting-metric strong').evaluateAll(nodes => nodes.map(n => Number(n.textContent.replace(/\D/g, ''))));
    assert.deepEqual(await page.locator('.meeting-metric p').allTextContents(), labels);
    assert.deepEqual(await values(), expected(data.records));
    proof.metrics = Object.fromEntries(labels.map((v, i) => [v, expected(data.records)[i]]));
    for (let i = 1; i < 4; i++) {
      await page.getByRole('button', { name: `查看${labels[i]}`, exact: true }).click();
      await page.getByRole('dialog').getByText(`${expected(data.records)[i]} 条记录`, { exact: true }).waitFor();
      assert(await page.getByRole('dialog').locator('.meeting-demo-drill-list section').count() <= 12);
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    }
    check('四张业务指标使用真实记录、点击下钻人数与记录数没有混算');
    const heights = await page.locator('.meeting-overview-charts > .meeting-analysis-panel').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
    assert(Math.abs(heights[0] - heights[1]) < 2);
    const palette = await page.locator('.meeting-overview').evaluate(n => {
      const s = getComputedStyle(n);
      return Object.fromEntries(['blue','cyan','indigo','amber','neutral'].map(tone => [tone, s.getPropertyValue(`--meeting-chart-${tone}`).trim()]));
    });
    const colorsMatch = await page.evaluate(palette => {
      const context = document.createElement('canvas').getContext('2d');
      const normalize = color => { context.fillStyle = color; return context.fillStyle; };
      return normalize(palette.blue) === normalize('hsl(217 92% 62%)')
        && normalize(palette.cyan) === normalize('hsl(186 78% 47%)');
    }, palette);
    assert(colorsMatch);
    proof.palette = palette;
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    check('明亮色板已生效，同排图表等高、环图未分类采用中性色');
    const before = reads;
    const month = data.records.find(r => r.date?.startsWith('2026-07'))?.date.slice(0,7) || data.records.find(r => r.date)?.date.slice(0,7);
    await page.getByLabel('总览月份', { exact: true }).selectOption(month);
    const rows = data.records.filter(r => r.date?.startsWith(month));
    assert.deepEqual(await values(), expected(rows));
    await page.getByRole('button', { name: '查看客户沟通', exact: true }).click();
    await page.getByRole('dialog').getByText(`${expected(rows)[1]} 条记录`, { exact: true }).waitFor();
    assert((await page.getByRole('dialog').locator('.meeting-demo-drill-list small').allTextContents()).every(v => v.startsWith(month)));
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(reads, before);
    check('月份筛选同步改变四指标与下钻，不重复读取外部源');
    await page.getByLabel('总览范围', { exact: true }).selectOption('总部');
    assert.deepEqual(await values(), [0,0,0,0]);
    await page.getByRole('button', { name: '查看专业研讨', exact: true }).click();
    await page.getByRole('dialog').getByText('没有符合条件的记录', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '重置', exact: true }).click();
    check('空筛选真实显示0、空下钻可正常关闭');
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
    assert.deepEqual(await values(), expected(data.records));
    const inside = await page.locator('.meeting-metric').evaluateAll(nodes => nodes.every(card => {
      const rect = card.getBoundingClientRect();
      return [...card.querySelectorAll('p,strong,small')].every(n => { const r = n.getBoundingClientRect(); return r.left >= rect.left - 1 && r.right <= rect.right + 1; });
    }));
    assert(inside);
    await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '查看学习分享', exact: true }).click();
    assert(await page.getByRole('dialog').evaluate(n => n.scrollWidth <= n.clientWidth + 2));
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    check('390px四卡文本与数值不溢出，图表和下钻无横向滚动');
    assert.deepEqual(proof.errors, []);
    proof.passed = true;
  } finally {
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'browser-proof.json'), JSON.stringify(proof, null, 2));
    await browser.close();
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
