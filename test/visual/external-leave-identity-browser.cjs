const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const origin = 'http://127.0.0.1:43236';
const out = path.resolve('output/playwright/external-leave-identity');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII=', 'base64');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/qa/external`);
    await page.goto(`${origin}/monthly-schedule?form=leave`);
    const dialog = page.getByRole('dialog').filter({ hasText: '请休假&差旅申请' });
    await dialog.waitFor();
    const input = dialog.locator('#leave-staff-name');
    await page.waitForFunction(() => document.querySelector('#leave-staff-name')?.value === '验收员工乙');
    assert.notEqual(await input.getAttribute('readonly'), null);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select')].slice(0, 4).every(select => select.value));
    await dialog.locator('select').last().selectOption({ label: '事假' });
    await dialog.locator('#leave-reason').fill('隔离验收：外部姓名账号请休假');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'external-qa.png', mimeType: 'image/png', buffer: png });
    await dialog.screenshot({ path: path.join(out, 'desktop.png') });
    await page.request.get(`${origin}/qa/result/failure`);
    const failed = page.waitForResponse(response => response.url().endsWith('/leave-request') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    assert.equal((await failed).status(), 400);
    await dialog.getByText('提交失败，已保留当前填写内容，可修改后重试。', { exact: true }).waitFor();
    assert.equal(await dialog.locator('#leave-reason').inputValue(), '隔离验收：外部姓名账号请休假');
    await page.request.get(`${origin}/qa/result/success`);
    const succeeded = page.waitForResponse(response => response.url().endsWith('/leave-request') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    const response = await succeeded;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).leaveStaffName, '验收员工乙');
    const entries = (await (await page.request.get(`${origin}/qa/report`)).json()).filter(item => item.submission === true);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].clientMutationId, entries[1].clientMutationId);
    checks.push('readonly self identity; failure preserves draft; retry succeeds with the same mutation');
    const forged = await page.request.post(`${origin}/api/duty-schedules/leave-request`, {
      multipart: { payload: JSON.stringify({ leaveStaffName: '验收员工甲' }) },
    });
    assert.equal(forged.status(), 403);
    checks.push('forged other-person submission rejected');
    await page.setViewportSize({ width: 390, height: 1050 });
    await page.goto(`${origin}/monthly-schedule?form=leave`);
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('#leave-staff-name')?.value === '验收员工乙');
    assert.notEqual(await input.getAttribute('readonly'), null);
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await dialog.screenshot({ path: path.join(out, 'mobile.png') });
    checks.push('390px mobile readonly self identity without horizontal overflow');
    assert.deepEqual(errors, []);
    const result = { passed: true, checks, errors, testedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
