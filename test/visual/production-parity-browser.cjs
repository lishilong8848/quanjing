const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const out = path.resolve('output/production-parity-validation-20261010');
const coldCount = require('../../shared/hvac-thresholds.seed.json').records.filter(r => r.device === '冷水机组').length;
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], errors: [], rejectedExternalHosts: [] };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') { proof.rejectedExternalHosts.push(url.hostname); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', e => proof.errors.push(e.message));
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('http://127.0.0.1:4198/threshold-management');
      await page.locator('.threshold-sheet').waitFor();
      const threshold = await page.locator('.threshold-page').evaluate(el => ({ bg: getComputedStyle(el).getPropertyValue('--tm-bg').trim(), overflow: document.documentElement.scrollWidth > innerWidth, sheet: getComputedStyle(el.querySelector('.threshold-sheet')).backgroundColor }));
      assert(threshold.bg, 'threshold root variables missing');
      assert.equal(threshold.overflow, false);
      await page.getByRole('button', { name: '暖通', exact: true }).click();
      const coldDevice = page.locator("nav[aria-label='设备工作表'] button").filter({ hasText: '冷水机组' });
      await coldDevice.waitFor();
      assert.equal(await coldDevice.locator('small').textContent(), String(coldCount));
      await coldDevice.click();
      await page.screenshot({ path: path.join(out, `threshold-${width}.png`) });
      proof.checks.push({ name: 'threshold-vars-profession-device-layout', width, threshold });
      await page.goto('http://127.0.0.1:4198/meeting-management/nantong-weekly');
      const panel = page.locator('.weekly-workbench');
      await panel.getByRole('button', { name: '阿里待办', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('select[aria-label="目标周报"]')?.value === 'recParityWeekly');
      const weekly = await panel.evaluate(el => { const content = el.querySelector('.weekly-workbench-content'); return { gap: getComputedStyle(el).getPropertyValue('--meeting-gap').trim(), padding: parseFloat(getComputedStyle(content).paddingTop), overflow: document.documentElement.scrollWidth > innerWidth, actions: [...el.querySelectorAll('.weekly-console-action > button')].map(b => ({ height: b.getBoundingClientRect().height, top: b.getBoundingClientRect().top })) }; });
      assert(weekly.gap, 'meeting root variables missing');
      assert(weekly.padding >= (width < 768 ? 16 : 24));
      assert.equal(weekly.overflow, false);
      await page.screenshot({ path: path.join(out, `weekly-${width}.png`) });
      await panel.getByRole('button', { name: '生成周报', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('link', { name: '查看周报模板 v3' }).waitFor();
      assert(await dialog.getByRole('button', { name: '开始生成', exact: true }).isDisabled(), 'empty todos require confirmation');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await panel.getByRole('button', { name: '新建条目', exact: true }).click();
      await page.getByRole('dialog').getByRole('heading', { name: '新建周报条目', exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      proof.checks.push({ name: 'weekly-padding-layout-separate-create-generate-empty-confirmation', width, weekly });
    }
    assert.equal(proof.errors.length, 0);
    proof.passed = true;
  } catch (error) { proof.error = error.stack; process.exitCode = 1; }
  finally { await browser.close(); proof.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, `browser-proof-${Date.now()}.json`), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof)); }
})();
