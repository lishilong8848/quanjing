const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const out = path.resolve('output/production-parity-validation-20261010');
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], pageErrors: [], businessWrites: [], rejectedExternalHosts: [] };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname !== '127.0.0.1') { proof.rejectedExternalHosts.push(url.hostname); return route.abort(); }
      if (url.pathname.startsWith('/api/') && request.method() !== 'GET') proof.businessWrites.push({ path: url.pathname, method: request.method() });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', e => proof.pageErrors.push(e.message));
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('http://127.0.0.1:4198/inventory-management?view=stocktake&action=execute&scope=review&month=2026-10');
      await page.getByRole('button', { name: '一键确认', exact: true }).waitFor();
      const layout = await page.locator('.inventory-stocktake').evaluate(el => ({ gap: getComputedStyle(el).getPropertyValue('--stocktake-gap').trim(), overflow: document.documentElement.scrollWidth > innerWidth }));
      assert(layout.gap, 'Stocktake first-rule variables missing');
      assert.equal(layout.overflow, false);
      await page.getByRole('button', { name: '一键确认', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: '一键确认库存核盘', exact: true }).waitFor();
      assert(await dialog.getByText('3 项待确认', { exact: true }).isVisible());
      assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      assert.equal(await page.getByText('Request failed with status code 404', { exact: true }).count(), 0, 'Fixture sync-status must be bound');
      await page.screenshot({ path: path.join(out, `stocktake-bulk-settled-${width}.png`) });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      proof.checks.push({ name: 'inventory-review-bulk-dialog-source-styles-and-count', width, layout });
      await page.goto('http://127.0.0.1:4198/operations-architecture');
      await page.getByRole('heading', { name: '南通全景运维调度中心业务架构图', exact: true }).waitFor();
      assert.equal(await page.locator('.ops-bottom-grid > *').count(), 8);
      await page.getByRole('button', { name: /^打开南通基地-百晓生本体能力弹窗/ }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.ops-baixiao-workspace')).every(el => Number(getComputedStyle(el).opacity) === 1));
      await page.screenshot({ path: path.join(out, `architecture-dialog-settled-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      proof.checks.push({ name: 'operations-architecture-eight-modules-dialog-close', width });
    }
    assert.deepEqual(proof.businessWrites, []);
    assert.deepEqual(proof.pageErrors, []);
    proof.passed = true;
  } catch (error) { proof.error = error.stack; process.exitCode = 1; }
  finally { await browser.close(); proof.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, `other-updates-browser-${Date.now()}.json`), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof)); }
})();
