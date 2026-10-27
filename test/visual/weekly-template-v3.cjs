const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const out = path.resolve('output/weekly-template-v3-validation-20261009');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], pageErrors: [], toolSha256: sha(__filename) };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', (error) => proof.pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4200/meeting-templates/nantong-weekly-v3.html');
    for (const name of ['一、本周待办', '二、本周周会内容', '三、专业线', '四、运营线']) await page.getByRole('heading', { name, exact: true }).waitFor();
    assert.equal(await page.locator('.building').count(), 6);
    await page.getByRole('button', { name: '简洁汇总', exact: true }).click();
    assert.equal(await page.locator('.detail-area').first().isVisible(), false);
    await page.getByRole('button', { name: '含场景简述', exact: true }).click();
    assert(await page.locator('.detail-area').first().isVisible());
    assert((await page.locator('.source').first().innerText()).includes('保留责任人员'));
    await page.screenshot({ path: path.join(out, 'v3-template-desktop.png') });
    proof.checks.push({ name: 'v3-reference-and-mode-switch', passed: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('http://127.0.0.1:4200/meeting-templates/nantong-weekly-v3-generated-sample.html');
      const content = await page.locator('main').innerText();
      for (const value of ['一、本周待办', '二、本周周会内容', '三、专业线', '四、运营线', '二、效率（变更、维护、演练）', '本月已完成1/3项', '其中待审批1项', '场景简述', '演练楼栋待核对：1项', '马进宇', '2026-10-14', '电气专业线', '暖通专业线', '弱电专业线', 'EHS & 消防专业线', '成本支出']) assert(content.includes(value), value);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(out, `v3-generated-${width}.png`), fullPage: false });
      if (width === 1440) {
        await page.getByRole('heading', { name: '三、专业线', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'v3-professional-desktop.png') });
      }
      proof.checks.push({ name: 'real-renderer-sample', width, passed: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:4200/meeting-management/nantong-weekly');
    const card = page.locator('.weekly-workbench');
    await card.getByRole('combobox', { name: '目标周报' }).selectOption('new');
    await card.getByRole('button', { name: '生成周报', exact: true }).click();
    const link = page.getByRole('dialog').getByRole('link', { name: '查看周报模板 v3' });
    await link.waitFor();
    const opened = page.waitForEvent('popup');
    await link.click();
    const popup = await opened;
    await popup.getByRole('heading', { name: '三、专业线', exact: true }).waitFor();
    assert(popup.url().endsWith('/meeting-templates/nantong-weekly-v3.html'));
    await popup.close();
    proof.checks.push({ name: 'workbench-v3-entry', passed: true });
    assert.equal(proof.pageErrors.length, 0);
    const execution = JSON.parse(fs.readFileSync(path.join(out, 'execution-proof.json')));
    assert(execution.passed);
    for (const input of execution.inputs) assert.equal(sha(input.path), input.sha256);
    proof.executionProofSha256 = sha(path.join(out, 'execution-proof.json'));
    proof.passed = true;
  } catch (error) { proof.error = error.stack; process.exitCode = 1; }
  finally { await browser.close(); proof.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'browser-proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks.length, error: proof.error })); }
})();
