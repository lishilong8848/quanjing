const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const out = path.resolve('output/weekly-template-v3-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base = JSON.parse(fs.readFileSync('output/weekly-workbench-layout-20261009/execution-proof.json'));
const lintFiles = ['client/src/pages/MeetingManagement/WeeklyGenerateDialog.tsx', 'server/modules/meeting-management/meeting.document.ts', 'server/modules/meeting-management/meeting.document.spec.ts', 'server/modules/meeting-management/weekly.engine.ts'];
const files = [...new Set([...base.inputs.map((item) => item.path), ...lintFiles,
  'client/public/meeting-templates/nantong-weekly-v3.html',
  'client/public/meeting-templates/nantong-weekly-v3-generated-sample.html',
  'test/helpers/weekly-template-v3-preview.py', 'test/visual/weekly-workbench-layout.cjs', __filename,
  'D:/ai/codex/随心记/.superpowers/brainstorm/nantong-weekly-template-20261008/content/weekly-report-template-v3.html'])];
const proof = { startedAt: new Date().toISOString(), passed: false, inputs: files.map((file) => ({ path: file, sha256: sha(file) })), executions: [] };
try {
  for (const [name, binary, args] of [
    ['python-v3-tests', 'python', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/weekly-report', '-p', 'test_bridge.py']],
    ['document-and-engine-tests', process.execPath, ['node_modules/jest/bin/jest.js', '--config', 'test/jest.meeting-management.config.cjs', '--runInBand', '--runTestsByPath', 'server/modules/meeting-management/meeting.document.spec.ts', 'server/modules/meeting-management/weekly.engine.spec.ts', '--silent']],
    ['client-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json']],
    ['server-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json']],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', ...lintFiles, '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
    ['isolated-preview-compile', process.execPath, ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
  ]) {
    const started = performance.now();
    const result = spawnSync(binary, args, { env: { ...process.env, MEETING_BROWSER_MODE: 'production', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const log = path.join(out, name + '.log');
    fs.writeFileSync(log, (result.stdout || '') + '\n' + (result.stderr || '') + (result.error ? result.error.message : ''));
    proof.executions.push({ name, args, seconds: (performance.now() - started) / 1000, exitCode: result.status, logSha256: sha(log) });
    console.log(JSON.stringify(proof.executions.at(-1)));
    if (result.status !== 0) throw Error(name + '失败：' + log);
  }
  for (const input of proof.inputs) if (sha(input.path) !== input.sha256) throw Error('验证期间输入变化：' + input.path);
  proof.passed = true;
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
} finally {
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'execution-proof.json'), JSON.stringify(proof, null, 2));
}
