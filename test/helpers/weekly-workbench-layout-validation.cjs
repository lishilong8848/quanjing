const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const out = path.resolve('output/weekly-workbench-layout-20261009');
fs.mkdirSync(out, { recursive: true });
const files = [
  'client/src/pages/MeetingManagement/WeeklyWorkbench.tsx',
  'client/src/pages/MeetingManagement/WeeklyWorkbenchControls.tsx',
  'client/src/pages/MeetingManagement/WeeklyGenerateDialog.tsx',
  'client/src/pages/MeetingManagement/weekly-workbench.css',
  'server/modules/meeting-management/weekly.engine.ts',
  'scripts/weekly-report/bridge.py',
  'scripts/weekly-report/nantong_weekly_report.py',
  'scripts/weekly-report/test_bridge.py',
];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base = JSON.parse(fs.readFileSync('output/weekly-workbench-validation-20261009/execution-proof.json'));
const inputs = [...new Set([...base.inputs.map((item) => item.path), ...files,
  'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'test/helpers/meeting-browser.rspack.cjs', __filename])].map((file) => ({ path: file, sha256: sha(file) }));
const proof = { startedAt: new Date().toISOString(), passed: false, inputs, executions: [] };
try {
  for (const [name, binary, args, cwd] of [
    ['client-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json']],
    ['server-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json']],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', ...files.filter((file) => /tsx?$/.test(file)), '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
    ['styles', process.execPath, ['node_modules/stylelint/bin/stylelint.mjs', files[3]]],
    ['template-tests', 'python', ['-B', '-m', 'unittest', 'test_bridge.py'], path.resolve('scripts/weekly-report')],
    ['isolated-preview-compile', process.execPath, ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
  ]) {
    const start = performance.now();
    const result = spawnSync(binary, args, { cwd: cwd || process.cwd(), env: { ...process.env, MEETING_BROWSER_MODE: 'production', PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const log = path.join(out, name + '.log');
    fs.writeFileSync(log, (result.stdout || '') + '\n' + (result.stderr || '') + (result.error ? '\n' + result.error.message : ''));
    const execution = { name, args, cwd: cwd || process.cwd(), seconds: (performance.now() - start) / 1000, exitCode: result.status, logSha256: sha(log) };
    proof.executions.push(execution);
    console.log(JSON.stringify(execution));
    if (result.status !== 0) throw Error(name + '失败：' + log);
  }
  for (const input of inputs) if (input.sha256 !== sha(input.path)) throw Error('验证期间输入变化：' + input.path);
  proof.passed = true;
} catch (error) {
  proof.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'execution-proof.json'), JSON.stringify(proof, null, 2));
}
