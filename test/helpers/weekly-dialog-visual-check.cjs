const { chromium } = require('playwright-core');
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4203/meeting-management/nantong-weekly');
    await page.getByLabel('修改待办1', { exact: true }).click();
    await page.getByLabel('搜索在职员工').fill('马');
    console.log(await page.getByRole('dialog').evaluate(node => {
      const css = getComputedStyle(node);
      return { opacity: css.opacity, background: css.backgroundColor, animation: css.animation, zIndex: css.zIndex, overlay: [...document.querySelectorAll('[data-slot="dialog-overlay"]')].map(n => ({ z: getComputedStyle(n).zIndex, opacity: getComputedStyle(n).opacity })), classes: node.className };
    }));
    await page.screenshot({ path: 'output/weekly-actions-validation-20261009/edit-mobile-stable.png' });
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
