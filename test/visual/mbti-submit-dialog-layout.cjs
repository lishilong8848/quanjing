const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'client/src/pages/MbtiAssessment/styles.css'), 'utf8');
const chrome = process.env.CHROME_PATH || path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe');

async function main() {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(`
        <style>${css}</style>
        <dialog class="bank-submit-dialog" aria-labelledby="bank-submit-title">
          <h2 id="bank-submit-title">确认提交测试？</h2>
          <p>已完成全部 93 题。提交后即可查看你的 16 型人格偏好与分析。</p>
          <div><button class="mbti-secondary">返回检查</button><button class="mbti-primary">提交并查看结果</button></div>
        </dialog>
      `);
      await page.locator('dialog').evaluate((dialog) => dialog.showModal());
      const box = await page.locator('dialog').boundingBox();
      assert.ok(box, '提交弹窗应可见');
      assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2, '提交弹窗应水平居中');
      assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2, '提交弹窗应垂直居中');
      assert.ok(box.x >= 0 && box.y >= 0, '提交弹窗不得超出视口');
      for (const button of await page.locator('dialog button').all()) {
        const buttonBox = await button.boundingBox();
        assert.ok(buttonBox && buttonBox.width >= 44 && buttonBox.height >= 44, '操作按钮应易于点击');
        assert.ok(buttonBox.x >= box.x && buttonBox.x + buttonBox.width <= box.x + box.width, '操作按钮不得溢出弹窗');
      }
      console.log(`${viewport.width}x${viewport.height}: centered, buttons visible`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
