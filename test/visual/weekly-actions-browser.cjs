const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const out = path.resolve('output/weekly-actions-validation-20261009');
const api = 'http://127.0.0.1:4202';
const ui = 'http://127.0.0.1:4203';
const proof = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  errors: [],
  feedbackMs: [],
};
const capture = async (page, name) => {
  await page.waitForFunction(
    () =>
      !document.querySelector('[role="dialog"]') ||
      Number(
        getComputedStyle(document.querySelector('[role="dialog"]')).opacity,
      ) >= 0.999,
  );
  await page.screenshot({ path: path.join(out, name) });
};
const check = (text) => {
  proof.checks.push(text);
  console.log(text);
};
const control = (mode = 'normal', role = 'admin') =>
  fetch(`${api}/__qa/control?mode=${mode}&role=${role}`);
const snapshot = async () =>
  (await fetch(`${api}/api/meeting-management/snapshot`)).json();
const inspect = async (id) =>
  (await fetch(`${api}/__qa/weekly-record?id=${id}`)).json();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII=',
  'base64',
);
async function waitJob(id) {
  for (let i = 0; i < 60; i++) {
    const job = await (
      await fetch(`${api}/api/meeting-management/weekly/jobs/${id}`)
    ).json();
    if (['success', 'error', 'uncertain'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('后台任务未终态');
}
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const posts = [];
  page.on('pageerror', (error) => proof.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/weekly/'))
      posts.push(request.url());
  });
  const dialog = () => page.getByRole('dialog');
  const list = () => page.locator('.meeting-action-list');
  try {
    await control();
    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    await page.goto(`${ui}/meeting-management/nantong-weekly`);
    await list().locator('li').first().waitFor();
    const initial = await snapshot();
    const first = initial.latestActions.items[0];
    assert.equal(
      await list().locator('li').count(),
      initial.latestActions.items.length,
    );
    const heights = await list()
      .locator('li')
      .evaluateAll((rows) =>
        rows.map((row) => row.getBoundingClientRect().height),
      );
    assert(Math.max(...heights) <= 105, JSON.stringify(heights));
    await page.screenshot({
      path: path.join(out, 'compact-list-desktop.png'),
      fullPage: false,
    });
    check('PC清单紧凑，全部历史待办和来源保留');

    await page.getByLabel('修改待办1', { exact: true }).click();
    await dialog().getByLabel('搜索在职员工').fill('马');
    await dialog().getByRole('button', { name: '马进宇', exact: true }).click();
    const revised = `${first.content}【隔离验收修改】`;
    await dialog().getByLabel('待办内容', { exact: true }).fill(revised);
    await control('weekly-delay');
    const beforePosts = posts.length;
    await page.evaluate(() => {
      window.__actionStart = performance.now();
      const observer = new MutationObserver(() => {
        if (
          document
            .querySelector('.meeting-action-list')
            ?.textContent.includes('同步中')
        ) {
          window.__actionFeedback = performance.now() - window.__actionStart;
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      const button = [
        ...document.querySelectorAll('[role="dialog"] button'),
      ].find((node) => node.textContent === '保存');
      button.click();
      button.click();
    });
    await dialog().getByText('待办已保存', { exact: true }).waitFor();
    proof.feedbackMs.push(await page.evaluate(() => window.__actionFeedback));
    assert.equal(posts.length - beforePosts, 1);
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await list().getByText('在职员工', { exact: true }).waitFor();
    const edited = await snapshot();
    assert(edited.latestActions.items[0].content.startsWith(revised));
    assert.equal(
      edited.latestActions.items[0].assignee.openId,
      'ou_a6644e62a43b916c6bc26148cf74f208',
    );
    assert.deepEqual(
      edited.latestActions.items.slice(1),
      initial.latestActions.items.slice(1),
    );
    check('内容和员工责任人同步、刷新保留、相邻事项不变、重复点击只提交一次');

    await control('weekly-fail');
    await page.getByLabel('修改责任人2', { exact: true }).click();
    await dialog()
      .getByRole('button', { name: '自定义人员', exact: true })
      .click();
    await dialog().getByLabel('自定义责任人').fill('唐工');
    await dialog()
      .getByLabel('待办内容', { exact: true })
      .fill('隔离验收：协调厂家修复照明并保留备件');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog()
      .getByRole('button', { name: '重试同步', exact: true })
      .waitFor();
    assert.equal(
      await dialog().getByLabel('待办内容').inputValue(),
      '隔离验收：协调厂家修复照明并保留备件',
    );
    assert.equal(
      (await snapshot()).latestActions.items[1].content,
      initial.latestActions.items[1].content,
    );
    await control();
    await dialog()
      .getByRole('button', { name: '重试同步', exact: true })
      .click();
    await dialog().getByText('待办已保存', { exact: true }).waitFor();
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await list().getByText('自定义人员', { exact: true }).waitFor();
    check('自定义人员醒目标识，失败精确回滚、草稿保留、重试原任务成功');

    const current = (await snapshot()).latestActions.items[2];
    await page.getByLabel('修改待办3', { exact: true }).click();
    await dialog().getByLabel('待办内容').fill('本地冲突草稿');
    const conflicting = await (
      await fetch(`${api}/api/meeting-management/weekly/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: crypto.randomUUID(),
          targetRecordId: current.sourceRecordId,
          actionId: current.id,
          expectedContent: current.content,
          content: '其他人员先修改的内容',
        }),
      })
    ).json();
    assert.equal((await waitJob(conflicting.id)).status, 'success');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog()
      .getByText(/已被修改/)
      .waitFor();
    assert.equal(
      await dialog().getByLabel('待办内容').inputValue(),
      '本地冲突草稿',
    );
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    check('并发原文冲突拒绝覆盖，编辑草稿保留');

    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    await control();
    await page.reload();
    await page.getByText('隔离验收：不会写入飞书', { exact: true }).waitFor();
    const target = initial.records
      .filter((row) => row.source === 'nantong-weekly')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    await page.getByLabel('目标周报').selectOption(target.id);
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    const block =
      'A楼：\n1. 检查照明\n  保留缩进及补充说明\n\n2. 复核液位（责任人：唐工）\n' +
      '完整会议待办补充内容。'.repeat(300);
    await dialog().getByLabel('整段待办内容').fill(block);
    await dialog()
      .getByLabel('选择会议图片')
      .setInputFiles([
        { name: '会议截图.png', mimeType: 'image/png', buffer: png },
        {
          name: '第二张.png',
          mimeType: 'image/png',
          buffer: Buffer.concat([png, Buffer.from([0])]),
        },
      ]);
    assert.equal(
      await dialog().locator('.weekly-image-previews img').count(),
      2,
    );
    await capture(page, 'bulk-images-desktop.png');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.weekly-job')].some(
        (node) =>
          node.textContent.includes('会议图片') &&
          node.textContent.includes('已完成'),
      ),
    );
    let state = await inspect(target.id);
    assert.equal(state.fields['阿里会议待办'], block);
    assert.equal(state.fields['阿里会议附件'].length, 2);
    assert.equal(state.imageUploads, 2);
    check('整段原文、编号/空行/缩进保留，两张图片预览及独立任务同步成功');

    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    await control('image-write-fail');
    await page.reload();
    await page.getByText('隔离验收：不会写入飞书', { exact: true }).waitFor();
    await page.getByLabel('目标周报').selectOption(target.id);
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await dialog()
      .getByLabel('整段待办内容')
      .fill('隔离验收：附件回填失败时文本仍保存');
    await dialog()
      .getByLabel('选择会议图片')
      .setInputFiles({
        name: '失败重试.png',
        mimeType: 'image/png',
        buffer: png,
      });
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    const imageJob = page
      .locator('.weekly-job')
      .filter({ hasText: '会议图片' });
    await imageJob
      .getByRole('button', { name: '重试失败步骤', exact: true })
      .waitFor();
    state = await inspect(target.id);
    assert.equal(
      state.fields['阿里会议待办'],
      '隔离验收：附件回填失败时文本仍保存',
    );
    assert.equal(state.imageUploads, 1);
    await control();
    await imageJob
      .getByRole('button', { name: '重试失败步骤', exact: true })
      .click();
    await imageJob.getByText('已完成', { exact: true }).waitFor();
    state = await inspect(target.id);
    assert.equal(state.imageUploads, 1);
    assert.equal(state.fields['阿里会议附件'].length, 1);
    check('图片回填失败不影响文本，重试只回填不重复上传');

    await page.setViewportSize({ width: 390, height: 844 });
    await list().locator('li').first().scrollIntoViewIfNeeded();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.getByLabel('修改待办1', { exact: true }).click();
    assert(
      await dialog().evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    );
    await capture(page, 'edit-mobile.png');
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    check('390px手机清单及编辑弹窗无横向溢出');

    await control('normal', 'visitor');
    const denied = await fetch(`${api}/api/meeting-management/weekly/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    await page.reload();
    await page
      .getByText('当前账号无会议归档访问权限', { exact: true })
      .waitFor();
    await control();
    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    assert(!(await inspect(target.id)).jobs.length);
    check('无权限写入拒绝，隔离台账和验收数据已清理');
    assert(!proof.errors.length, proof.errors.join('\n'));
    assert(
      proof.feedbackMs.every((ms) => ms <= 100),
      JSON.stringify(proof.feedbackMs),
    );
    proof.passed = true;
  } finally {
    await browser.close();
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(out, 'browser-proof.json'),
      JSON.stringify(proof, null, 2),
    );
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
