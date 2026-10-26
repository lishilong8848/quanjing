const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const out = path.resolve('output/weekly-template-type-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = ['client/public/meeting-templates/weekly-template.css', 'client/public/meeting-templates/nantong-weekly-v3.html', 'client/public/meeting-templates/nantong-weekly-v3-generated-sample.html', 'test/helpers/weekly-template-v3-preview.py', __filename];
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], pageErrors: [], executions: [], inputs: files.map((file) => ({ path: file, sha256: sha(file) })) };
(async () => {
  let browser;
  try {
    const start = performance.now();
    const result = spawnSync(process.execPath, ['node_modules/stylelint/bin/stylelint.mjs', files[0]], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const log = path.join(out, 'stylelint.log');
    fs.writeFileSync(log, (result.stdout || '') + '\n' + (result.stderr || ''));
    proof.executions.push({ command: 'node node_modules/stylelint/bin/stylelint.mjs ' + files[0], exitCode: result.status, seconds: (performance.now() - start) / 1000, logSha256: sha(log) });
    assert.equal(result.status, 0);
    const previous = JSON.parse(fs.readFileSync('output/weekly-template-v3-validation-20261009/template-proof.json'));
    const current = JSON.parse(fs.readFileSync(path.join(out, 'template-proof.json')));
    assert.equal(current.rendererSha256, previous.rendererSha256);
    assert.equal(current.generatedXmlSha256, previous.generatedXmlSha256);
    assert.equal(current.templateSha256, previous.templateSha256);
    proof.generatorUnchanged = { rendererSha256: current.rendererSha256, generatedXmlSha256: current.generatedXmlSha256, templateSourceSha256: current.templateSha256 };
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => proof.pageErrors.push(error.message));
    for (const variant of ['nantong-weekly-v3', 'nantong-weekly-v3-generated-sample']) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('http://127.0.0.1:4200/meeting-templates/' + variant + '.html');
        const metrics = await page.locator('.sheet').evaluate((sheet) => ({
          bodySize: parseFloat(getComputedStyle(sheet).fontSize),
          headings: [...sheet.querySelectorAll('h4,h5,h6')].map((heading) => ({ text: heading.textContent.trim(), size: parseFloat(getComputedStyle(heading).fontSize) })),
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
        assert.equal(metrics.bodySize, 16);
        assert(metrics.headings.length > 0);
        assert(metrics.headings.every((item) => item.size >= 16));
        assert.equal(metrics.overflow, false);
        const detail = page.getByRole('heading', { name: /^1[、，.]\s*变更[：:]?$/ }).first();
        await detail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, variant + '-' + width + '.png') });
        proof.checks.push({ variant, width, metrics });
      }
    }
    assert.equal(proof.pageErrors.length, 0);
    for (const input of proof.inputs) assert.equal(sha(input.path), input.sha256, input.path);
    proof.passed = true;
  } catch (error) { proof.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'browser-proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks.length, error: proof.error }));
  }
})();
