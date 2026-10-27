const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const origin = 'http://127.0.0.1:43236';
const out = path.resolve('output/playwright/station-110-workforce');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII=', 'base64');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/qa/station`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.goto(`${origin}/monthly-schedule?form=leave`);
      const dialog = page.getByRole('dialog').filter({ hasText: '请休假&差旅申请' });
      await dialog.waitFor();
      const input = dialog.locator('#leave-staff-name');
      assert.equal(await input.getAttribute('readonly'), null);
      await input.fill('验收');
      await dialog.getByRole('button', { name: '验收110人员甲', exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: '验收员工甲', exact: true }).count(), 0);
      const started = Date.now();
      await dialog.getByRole('button', { name: '验收110人员甲', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#leave-staff-name')?.value === '验收110人员甲');
      const selectionMs = Date.now() - started;
      await dialog.getByText('110站值班人员', { exact: true }).waitFor();
      assert((await dialog.innerText()).includes('110站值班人员'));
      assert(!(await dialog.innerText()).includes('未匹配到登录人员'));
      await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select')].slice(0, 4).every(select => select.value));
      await dialog.locator('select').last().selectOption({ label: '差旅' });
      assert.equal(await dialog.locator('select').last().inputValue(), '差旅');
      assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await dialog.screenshot({ path: path.join(out, `leave-${width}.png`) });
      checks.push({ view: 'leave', width, person: await input.inputValue(), selectionMs });
      console.log(`leave selection verified: ${width}`);
      if (width === 1440) {
        await dialog.locator('#leave-reason').fill('隔离验收：110差旅申请');
        await dialog.locator('input[type=file]').setInputFiles({ name: 'station-qa.png', mimeType: 'image/png', buffer: png });
        await page.request.get(`${origin}/qa/result/failure`);
        const failed = page.waitForResponse(response => response.url().endsWith('/leave-request') && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: '提交', exact: true }).click();
        assert.equal((await failed).status(), 400);
        await dialog.getByText('提交失败，已保留当前填写内容，可修改后重试。', { exact: true }).waitFor();
        assert.equal(await dialog.locator('#leave-reason').inputValue(), '隔离验收：110差旅申请');
        assert.equal(await input.inputValue(), '验收110人员甲');
        await page.request.get(`${origin}/qa/result/success`);
        const succeeded = page.waitForResponse(response => response.url().endsWith('/leave-request') && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: '提交', exact: true }).click();
        assert.equal((await succeeded).status(), 200);
        const submissions = (await (await page.request.get(`${origin}/qa/report`)).json()).filter(item => item.submission === true);
        assert.equal(submissions.length, 2);
        assert.equal(submissions[0].clientMutationId, submissions[1].clientMutationId);
        assert(submissions.every(item => item.name === '验收110人员甲'));
        checks.push({ view: 'leave-submit', failurePreservedDraft: true, retryReusedMutation: true });
      }

      await page.goto(`${origin}/monthly-schedule?form=overtime`);
      const overtime = page.getByRole('dialog', { name: '加班申请' });
      await overtime.waitFor();
      const search = overtime.getByPlaceholder('输入姓名快速匹配');
      await search.fill('验收');
      await overtime.getByRole('button', { name: /验收110人员甲/ }).waitFor();
      assert.equal(await overtime.getByRole('button', { name: /^验收员工甲/ }).count(), 0);
      await overtime.getByRole('button', { name: /验收110人员甲/ }).click();
      await overtime.getByText('110站值班人员', { exact: true }).waitFor();
      assert((await overtime.innerText()).includes('110站值班人员'));
      assert(!(await overtime.innerText()).includes('未匹配到登录人员'));
      assert(await overtime.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await overtime.screenshot({ path: path.join(out, `overtime-${width}.png`) });
      checks.push({ view: 'overtime', width, person: await search.inputValue() });
    }
    assert.deepEqual(errors, []);
    const result = { passed: true, checks, errors, testedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
    throw error;
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
