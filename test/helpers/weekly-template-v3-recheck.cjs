const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const out = path.resolve('output/weekly-template-v3-validation-20261009'), proofPath = path.join(out, 'execution-proof.json');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base = JSON.parse(fs.readFileSync(proofPath));
const updated = 'client/src/pages/MeetingManagement/WeeklyGenerateDialog.tsx';
const proof = { startedAt: new Date().toISOString(), passed: false, previousProofSha256: sha(proofPath), inputs: base.inputs.map((item) => ({ ...item, sha256: sha(item.path) })), executions: [] };
try {
  for (const item of base.inputs) if (item.path !== updated && sha(item.path) !== item.sha256) throw Error('复用证据失效：' + item.path);
  fs.copyFileSync(proofPath, path.join(out, 'relative-link-lint-failure-proof.json'));
  proof.reusedExecutions = base.executions.filter((item) => item.exitCode === 0 && item.name !== 'client-types');
  for (const [name, args] of [
    ['client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json']],
    ['lint', ['node_modules/eslint/bin/eslint.js', updated, 'server/modules/meeting-management/meeting.document.ts', 'server/modules/meeting-management/weekly.engine.ts', '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
    ['isolated-preview-compile', ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
  ]) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { env: { ...process.env, MEETING_BROWSER_MODE: 'production' }, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const log = path.join(out, name + '-recheck.log');
    fs.writeFileSync(log, (result.stdout || '') + '\n' + (result.stderr || ''));
    proof.executions.push({ name, args, exitCode: result.status, seconds: (performance.now() - start) / 1000, logSha256: sha(log) });
    console.log(JSON.stringify(proof.executions.at(-1)));
    if (result.status !== 0) throw Error(name + '失败');
  }
  for (const item of proof.inputs) if (sha(item.path) !== item.sha256) throw Error('验证期间源码变化：' + item.path);
  proof.toolSha256 = sha(__filename);
  proof.passed = true;
} catch (error) { proof.error = error.message; process.exitCode = 1; }
finally { proof.finishedAt = new Date().toISOString(); fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2)); }
