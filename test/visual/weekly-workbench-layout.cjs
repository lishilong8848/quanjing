const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const out = path.resolve('output/weekly-workbench-layout-20261009');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], pageErrors: [], toolSha256: sha(__filename), executionProofSha256: sha(path.join(out, 'execution-proof.json')) };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const data = await (await fetch('http://127.0.0.1:4201/api/meeting-management/weekly/workspace')).json();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
    page.on('pageerror', (error) => proof.pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4200/meeting-management/nantong-weekly');
    const card = page.locator('.weekly-workbench');
    const select = card.getByRole('combobox', { name: '目标周报' });
    await card.getByRole('button', { name: '阿里待办', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.weekly-workbench select')?.value);
    assert.equal(await card.getByText('模板待核对', { exact: true }).count(), 0);
    assert.equal(await card.getByText('自动生成未启用', { exact: true }).count(), 0);
    for (const width of [1920, 1440, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const metrics = await card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const content = element.querySelector('.weekly-workbench-content');
        const title = element.querySelector('h2').getBoundingClientRect();
        const buttons = [...element.querySelectorAll('.weekly-console-action > button')].map((button) => {
          const r = button.getBoundingClientRect();
          const t = button.querySelector('strong').getBoundingClientRect();
          return { top: r.top, height: r.height, left: r.left, right: r.right, textTop: t.top - r.top, textRight: r.right - t.right };
        });
        return { padding: Number.parseFloat(getComputedStyle(content).paddingTop), titleInset: title.top - rect.top,
          overflow: element.scrollWidth > element.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth, buttons };
      });
      assert(metrics.padding >= (width <= 768 ? 16 : 24));
      assert(metrics.titleInset >= metrics.padding);
      assert.equal(metrics.overflow, false);
      assert.equal(metrics.pageOverflow, false);
      assert(metrics.buttons.every((button) => button.textTop >= 15 && button.textRight >= 15));
      if (width > 768) assert(metrics.buttons.every((button) => button.top === metrics.buttons[0].top && button.height === metrics.buttons[0].height));
      proof.checks.push({ name: 'layout', width, metrics });
      if (width === 1920 || width === 390) await card.screenshot({ path: path.join(out, `workbench-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await select.selectOption('');
    await card.getByText('请选择目标周报，或新建条目', { exact: true }).waitFor();
    assert.equal(await card.locator('#weekly-console-notice').count(), 1);
    for (const name of ['阿里待办', '属地周会待办', '生成周报']) assert(await card.getByRole('button', { name, exact: true }).isDisabled());
    await select.selectOption('new');
    await card.getByText('新建条目后即可填写会议待办', { exact: true }).waitFor();
    assert(await card.getByRole('button', { name: '阿里待办', exact: true }).isDisabled());
    await card.getByRole('button', { name: '生成周报', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('link', { name: '查看周报模板 v3' }).waitFor();
    assert.equal(await dialog.getByRole('link', { name: '查看周报模板 v3' }).getAttribute('href'), '/meeting-templates/nantong-weekly-v3.html');
    await dialog.getByText('定时生成尚未开启，可手动生成', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await card.getByRole('button', { name: '新建条目', exact: true }).click();
    await dialog.getByRole('heading', { name: '新建周报条目', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('link', { name: '查看周报模板 v3' }).count(), 0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    proof.checks.push({ name: 'blank-new-generate-and-create', passed: true });

    for (const mode of ['unready', 'enabled', 'blocked']) {
      const variant = await browser.newPage({ viewport: { width: 390, height: 1000 } });
      variant.on('pageerror', (error) => proof.pageErrors.push(error.message));
      const workspace = structuredClone(data);
      workspace.jobs = [];
      if (mode === 'unready') workspace.runtime = { ...workspace.runtime, ready: false, message: '生成暂不可用，请检查配置' };
      if (mode === 'enabled') workspace.schedule.enabled = true;
      await variant.route('**/api/meeting-management/weekly/workspace', async (route) => {
        if (mode === 'blocked') {
          const snapshot = await (await fetch('http://127.0.0.1:4201/api/meeting-management/snapshot')).json();
          const target = snapshot.records.filter((item) => item.source === 'nantong-weekly').sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))[0];
          workspace.jobs = [{ id: 'layout-check-blocked', targetRecordId: target.id, kind: 'generate', status: 'running', stage: 'prepare', attempts: 1, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
        }
        await route.fulfill({ json: workspace });
      });
      await variant.goto('http://127.0.0.1:4200/meeting-management/nantong-weekly');
      const panel = variant.locator('.weekly-workbench');
      await variant.waitForFunction(() => document.querySelector('.weekly-workbench select')?.value);
      if (mode === 'unready') {
        await panel.getByText('生成暂不可用，请检查配置', { exact: true }).waitFor();
        assert(await panel.getByRole('button', { name: '生成周报', exact: true }).isDisabled());
        assert(await panel.getByRole('button', { name: '阿里待办', exact: true }).isEnabled());
        await panel.getByRole('combobox', { name: '目标周报' }).selectOption('new');
        await panel.getByText('新建条目后即可填写会议待办', { exact: true }).waitFor();
        assert.equal(await panel.getByText('生成暂不可用，请检查配置', { exact: true }).count(), 1);
      } else if (mode === 'enabled') {
        await panel.getByRole('combobox', { name: '目标周报' }).selectOption('new');
        await panel.getByRole('button', { name: '生成周报', exact: true }).click();
        await variant.getByRole('dialog').getByText('定时生成：每周四 08:30（北京时间）', { exact: true }).waitFor();
      } else {
        await panel.getByText('目标周报正在处理，请等待任务完成', { exact: true }).waitFor();
        assert.equal(await panel.getByText('目标周报正在处理，请等待任务完成', { exact: true }).count(), 1);
        assert(await panel.getByRole('button', { name: '生成周报', exact: true }).isDisabled());
        assert(await panel.getByRole('button', { name: '新建条目', exact: true }).isDisabled());
      }
      assert.equal(await variant.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      proof.checks.push({ name: mode, passed: true });
      await variant.close();
    }
    assert.equal(proof.pageErrors.length, 0);
    const execution = JSON.parse(fs.readFileSync(path.join(out, 'execution-proof.json')));
    assert(execution.passed);
    for (const input of execution.inputs) assert.equal(sha(input.path), input.sha256, input.path + ' changed');
    proof.passed = true;
  } catch (error) {
    proof.error = error.stack;
    process.exitCode = 1;
  } finally {
    await browser.close();
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'browser-proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks.length, error: proof.error }));
  }
})();
