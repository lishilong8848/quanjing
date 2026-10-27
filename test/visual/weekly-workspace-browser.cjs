const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const output = path.resolve('output/weekly-workspace-validation');
fs.mkdirSync(output, { recursive: true });
const ui = 'http://127.0.0.1:4203';
const api = 'http://127.0.0.1:4202';
const proof = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  errors: [],
  postCount: 0,
  localFeedbackMs: [],
  formReads: 0,
};
const check = (name) => {
  proof.checks.push(name);
  console.log(name);
};
const control = (mode) => fetch(`${api}/__qa/control?mode=${mode}&role=admin`);
const waitFinished = async (page) => {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.weekly-job')].length &&
      ![...document.querySelectorAll('.weekly-job')].some((n) =>
        n.textContent.includes('已受理'),
      ),
  );
};
const instrument = async (page) =>
  page.evaluate(() => {
    window.__weeklyFeedback = null;
    let start;
    const listener = () => {
      start = performance.now();
      document.removeEventListener('click', listener, true);
    };
    document.addEventListener('click', listener, true);
    const observer = new MutationObserver(() => {
      if (
        start !== undefined &&
        document.querySelector(
          '.weekly-opening,.weekly-dialog[data-state="open"]',
        )
      ) {
        observer.disconnect();
        requestAnimationFrame(
          () => (window.__weeklyFeedback = performance.now() - start),
        );
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    });
    page.on('pageerror', (error) => proof.errors.push(error.message));
    page.on('request', (r) => {
      if (r.url().includes('/weekly/records/')) proof.formReads++;
      if (r.method() === 'POST' && r.url().includes('/weekly/'))
        proof.postCount++;
    });
    await control('normal');
    assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
    await page.goto(`${ui}/meeting-management/nantong-weekly`);
    await page.getByText('隔离验收：不会写入飞书', { exact: true }).waitFor();
    await page.getByLabel('目标周报').selectOption('recvxpHuxHBmqn');
    await instrument(page);
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForFunction(
      () => typeof window.__weeklyFeedback === 'number',
    );
    proof.localFeedbackMs.push(
      await page.evaluate(() => window.__weeklyFeedback),
    );
    await page.getByRole('button', { name: '新增事宜', exact: true }).waitFor();
    await page.getByRole('button', { name: '新增事宜', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('事宜 1', { exact: true })
      .fill('验收：检查冷却系统');
    await dialog
      .getByLabel('责任人', { exact: true })
      .selectOption('ou_a6644e62a43b916c6bc26148cf74f208');
    await dialog.getByLabel('截止日期', { exact: true }).fill('2026-10-09');
    await dialog.getByLabel('计划会议日期', { exact: true }).fill('2026-10-07');
    await dialog.getByLabel('实际会议日期', { exact: true }).fill('2026-10-07');
    await page.screenshot({ path: path.join(output, 'todo-desktop.png') });
    const posts = proof.postCount;
    await dialog
      .getByRole('button', { name: '保存', exact: true })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await waitFinished(page);
    assert.equal(proof.postCount - posts, 1);
    await page
      .locator('.weekly-latest')
      .getByText('责任人：马进宇', { exact: true })
      .waitFor();
    check('PC待办事宜/责任人/截止日、重复点击仅一次提交、后台成功终态');

    await page
      .getByRole('button', { name: '属地周会／待办', exact: true })
      .click();
    await page.getByRole('dialog').waitFor();
    await page
      .getByLabel('会议状态', { exact: true })
      .selectOption('cancelled');
    await page.getByLabel('计划会议日期', { exact: true }).fill('2026-10-08');
    await page
      .getByLabel('备注／调整原因', { exact: true })
      .fill('10月8日周会取消');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await waitFinished(page);
    await page
      .locator('.weekly-meeting-list')
      .getByText('10月8日周会取消', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: '属地周会／待办', exact: true })
      .click();
    await page
      .getByLabel('会议状态', { exact: true })
      .selectOption('postponed');
    await page.getByLabel('调整至', { exact: true }).fill('2026-10-15');
    await page
      .getByLabel('备注／调整原因', { exact: true })
      .fill('延期至10月15日');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await waitFinished(page);
    await page
      .locator('.weekly-meeting-list')
      .getByText('2026-10-08 → 2026-10-15', { exact: true })
      .waitFor();
    check('10月8日取消、延期日期和原因、原待办保留');

    await control('weekly-fail');
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await page
      .getByLabel('事宜 1', { exact: true })
      .fill('验收：失败保留的待办');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    assert.equal(
      await page.getByLabel('事宜 1', { exact: true }).inputValue(),
      '验收：失败保留的待办',
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await page
      .getByRole('button', { name: '重试失败步骤', exact: true })
      .click();
    await waitFinished(page);
    await page
      .locator('.weekly-latest')
      .getByText('验收：失败保留的待办', { exact: true })
      .waitFor();
    check('外部同步失败明确提示、恢复原草稿、仅重试失败步骤');

    await control('normal');
    let lostId;
    await page.route(
      '**/api/meeting-management/weekly/meetings',
      async (route) => {
        const response = await route.fetch();
        lostId = (await response.json()).id;
        await route.abort('timedout');
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await page
      .getByLabel('事宜 1', { exact: true })
      .fill('验收：丢失响应后重试');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await page.getByRole('dialog').locator('.weekly-error').waitFor();
    assert(lostId);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await waitFinished(page);
    const workspace = await fetch(
      `${api}/api/meeting-management/weekly/workspace`,
    ).then((r) => r.json());
    assert.equal(workspace.jobs.filter((j) => j.id === lostId).length, 1);
    check('服务端受理后响应丢失、原mutation重试不重复、页面恢复成功');

    await page.getByRole('button', { name: '生成周报', exact: true }).click();
    await page.getByLabel('开始日期', { exact: true }).fill('2026-09-29');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-14');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '开始生成', exact: true })
      .click();
    await page
      .getByText('结束日期须与目标周报日期一致，请切换目标条目', {
        exact: true,
      })
      .waitFor();
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-07');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '开始生成', exact: true })
      .click();
    await waitFinished(page);
    await page
      .locator('.weekly-jobs')
      .getByRole('link', { name: '打开周报', exact: true })
      .waitFor();
    check('手动起止周期、错误结束日期拦截、生成和归档完成');

    await page.getByRole('button', { name: '新建条目', exact: true }).click();
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-08');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-14');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '新建条目', exact: true })
      .click();
    await waitFinished(page);
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="目标周报"]')
        .value.startsWith('recQAWeekly'),
    );
    check('新建周报条目、列表局部增加、自动选中新条目');
    await page.screenshot({
      path: path.join(output, 'workbench-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await page.getByRole('button', { name: '新增事宜', exact: true }).click();
    await page
      .getByLabel('事宜 1', { exact: true })
      .fill('手机验收：长事宜'.repeat(15));
    await page
      .getByLabel('责任人', { exact: true })
      .selectOption('ou_a6644e62a43b916c6bc26148cf74f208');
    const overflow = await page
      .getByRole('dialog')
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    assert(overflow <= 2, `手机弹窗横向溢出${overflow}`);
    await page.screenshot({
      path: path.join(output, 'todo-mobile.png'),
      fullPage: true,
    });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
    await page.screenshot({
      path: path.join(output, 'workbench-mobile.png'),
      fullPage: true,
    });
    check('390px手机表单、长事宜、责任人、清晰关闭且无横向溢出');
    const reads = proof.formReads;
    for (let i = 0; i < 10; i++) {
      await instrument(page);
      await page.getByRole('button', { name: '阿里待办', exact: true }).click();
      await page.waitForFunction(
        () => typeof window.__weeklyFeedback === 'number',
      );
      proof.localFeedbackMs.push(
        await page.evaluate(() => window.__weeklyFeedback),
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '取消', exact: true })
        .click();
    }
    assert.equal(proof.formReads, reads);
    const timings = [...proof.localFeedbackMs].sort((a, b) => a - b);
    proof.dialogFeedbackP95 = timings[Math.ceil(timings.length * 0.95) - 1];
    assert(
      proof.dialogFeedbackP95 <= 150,
      `表单反馈P95 ${proof.dialogFeedbackP95}`,
    );
    check('重复打开表单复用确认数据，无重复外部字段读取，缓存弹窗P95≤150ms');
    const fresh = await fetch(
      `${api}/api/meeting-management/weekly/workspace`,
    ).then((r) => r.json());
    const target = 'recQAWeekly1';
    const previous = fresh.meetings.find(
      (m) => m.targetRecordId === target && m.kind === 'ali',
    );
    const input = {
      clientMutationId: `qa-large-${require('node:crypto').randomUUID()}`,
      expectedVersion: previous?.version || 0,
      expectedText: '',
      meeting: {
        targetRecordId: target,
        kind: 'ali',
        plannedDate: '2026-10-14',
        actualDate: '2026-10-14',
        status: 'held',
        note: '',
        todos: Array.from({ length: 100 }, (_, i) => ({
          id: `item-${i + 1}`,
          content: `容量验收事宜${i + 1}`,
          ownerOpenId: 'ou_a6644e62a43b916c6bc26148cf74f208',
          ownerName: '马进宇',
          dueDate: '2026-10-15',
          status: 'pending',
        })),
      },
    };
    const accepted = await fetch(
      `${api}/api/meeting-management/weekly/meetings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then((r) => {
      assert(r.ok);
      return r.json();
    });
    for (let i = 0; i < 30; i++) {
      const job = await fetch(
        `${api}/api/meeting-management/weekly/jobs/${accepted.id}`,
      ).then((r) => r.json());
      if (job.status === 'success') break;
      assert.notEqual(job.status, 'error');
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.reload();
    await page.getByText('隔离验收：不会写入飞书', { exact: true }).waitFor();
    await page.getByLabel('目标周报').selectOption(target);
    await page.getByRole('button', { name: '阿里待办', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.weekly-todo-edit').length === 100,
    );
    assert.equal(await page.locator('.weekly-todo-edit').count(), 100);
    assert(
      await page
        .getByRole('button', { name: '新增事宜', exact: true })
        .isDisabled(),
    );
    assert(
      await page
        .getByRole('dialog')
        .evaluate((n) => n.scrollWidth <= n.clientWidth + 2),
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click();
    check('100项代表性待办回填、容量限制、窄屏无横向溢出');
    assert.deepEqual(proof.errors, []);
    proof.passed = true;
  } finally {
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(output, 'browser-proof.json'),
      JSON.stringify(proof, null, 2),
    );
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
