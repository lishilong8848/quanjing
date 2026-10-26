const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/training-sharing-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const fingerprint = file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') });
const sourceInputs = fs.readdirSync(path.join(root, 'client/src/pages/MeetingManagement')).filter(name => /\.(tsx?|css)$/.test(name)).map(name => `client/src/pages/MeetingManagement/${name}`);
const inputs = [...sourceInputs, 'shared/meeting-management.interface.ts', 'package.json', 'package-lock.json', 'tsconfig.app.json', 'test/helpers/meeting-browser.rspack.cjs', 'test/helpers/meeting-browser-entry.tsx', 'test/helpers/meeting-browser.css', 'test/helpers/training-sharing-verification.cjs'];
const before = inputs.map(fingerprint);
const steps = [
  ['client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json', '--incremental', '--tsBuildInfoFile', 'output/training-sharing-validation-20261009/client.tsbuildinfo']],
  ['eslint', ['node_modules/eslint/bin/eslint.js', 'client/src/pages/MeetingManagement/TrainingSharingBoard.tsx', 'client/src/pages/MeetingManagement/TrainingSharingPanels.tsx', 'client/src/pages/MeetingManagement/training-model.ts', 'client/src/pages/MeetingManagement/MeetingSourceBoard.tsx', 'client/src/pages/MeetingManagement/model.ts']],
  ['stylelint', ['node_modules/stylelint/bin/stylelint.mjs', 'client/src/pages/MeetingManagement/training-sharing.css']],
  ['isolated-compile', ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
];
const proof = { startedAt: new Date().toISOString(), passed: false, node: process.version, sourceInputs: before, executions: [] };
try {
  for (const [name, args] of steps) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, MEETING_BROWSER_MODE: 'production' }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const log = `${name}.log`;
    fs.writeFileSync(path.join(out, log), `${result.stdout || ''}\n${result.stderr || ''}${result.error ? `\n${result.error.message}` : ''}`);
    const execution = { name, command: 'node', args, startedAt, finishedAt: new Date().toISOString(), seconds: Number(((performance.now() - started) / 1000).toFixed(3)), exitCode: result.status, signal: result.signal, log: fingerprint(`output/training-sharing-validation-20261009/${log}`), tool: fingerprint(args[0]) };
    proof.executions.push(execution);
    console.log(JSON.stringify({ name, exitCode: result.status, seconds: execution.seconds }));
    if (result.status !== 0 || result.error) throw new Error(`${name} failed; see ${log}`);
  }
  if (JSON.stringify(before) !== JSON.stringify(inputs.map(fingerprint))) throw new Error('验证期间源码或配置发生变化');
  proof.passed = true;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'execution-proof.json'), JSON.stringify(proof, null, 2));
}
