const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const out = path.resolve('output/weekly-workbench-layout-20261009');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const proofPath = path.join(out, 'execution-proof.json');
const base = JSON.parse(fs.readFileSync(proofPath));
const updated = 'client/src/pages/MeetingManagement/weekly-workbench.css';
const proof = { startedAt: new Date().toISOString(), passed: false, previousProofSha256: sha(proofPath), inputs: base.inputs.map((item) => ({ ...item, sha256: sha(item.path) })), executions: [] };
try {
  assertUnchanged();
  fs.copyFileSync(proofPath, path.join(out, 'execution-before-flex-fix.json'));
  fs.copyFileSync(path.join(out, 'browser-proof.json'), path.join(out, 'browser-tablet-alignment-failure.json'));
  for (const [name, args] of [
    ['styles', ['node_modules/stylelint/bin/stylelint.mjs', updated]],
    ['isolated-preview-compile', ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
  ]) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { env: { ...process.env, MEETING_BROWSER_MODE: 'production' }, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const log = path.join(out, name + '-flex-fix.log');
    fs.writeFileSync(log, (result.stdout || '') + '\n' + (result.stderr || ''));
    proof.executions.push({ name, args, exitCode: result.status, seconds: (performance.now() - start) / 1000, logSha256: sha(log) });
    console.log(JSON.stringify(proof.executions.at(-1)));
    if (result.status !== 0) throw Error(name + '失败');
  }
  for (const item of proof.inputs) if (sha(item.path) !== item.sha256) throw Error('验证期间源码变化：' + item.path);
  proof.reusedExecutions = base.executions.filter((item) => !['styles', 'isolated-preview-compile'].includes(item.name));
  proof.toolSha256 = sha(__filename);
  proof.passed = true;
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
} finally {
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
}
function assertUnchanged() {
  if (!base.passed) throw Error('前置验证未通过');
  for (const item of base.inputs) if (item.path !== updated && sha(item.path) !== item.sha256) throw Error('复用证据失效：' + item.path);
}
