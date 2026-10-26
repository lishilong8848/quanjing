const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/weekly-workbench-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const sources = ['client/src/pages/MeetingManagement', 'server/modules/meeting-management'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(name => /\.(tsx?|css)$/.test(name)).map(name => `${dir}/${name}`));
const inputs = [...sources, 'shared/meeting-management.interface.ts', 'shared/weekly-workspace.interface.ts', 'shared/weekly-workspace.rules.ts', 'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json', 'test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser.rspack.cjs', 'test/helpers/meeting-browser-entry.tsx', 'test/helpers/meeting-browser-fixture.cjs', 'test/helpers/weekly-workbench-verification.cjs'];
const fingerprint = file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') });
const before = inputs.map(fingerprint);
const changed = sources.filter(file => /(?:MeetingActionEditDialog|LatestMeetingActions|WeeklyMeetingDialog|WeeklyImagePicker|WeeklyWorkbench|MeetingDetailDialog|index|weekly-api|meeting\.document|meeting\.mapper|meeting\.action-edit|weekly\.attachments|weekly\.service|weekly\.gateway|weekly\.store|weekly\.controller|meeting\.service)/.test(file) && !file.endsWith('.spec.ts'));
const steps = [
  ['related-tests', ['node_modules/jest/bin/jest.js', '--config', 'test/jest.meeting-management.config.cjs', '--runInBand', 'server/modules/meeting-management', 'test/unit/weekly-bulk-text.spec.ts', 'test/unit/weekly-form-api.spec.ts', 'test/unit/meeting-management-model.spec.ts', 'test/unit/training-sharing-model.spec.ts', 'test/unit/meeting-overview.spec.ts', '--json', '--outputFile', path.join(out, 'jest-results.json')]],
  ['server-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json']],
  ['client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json']],
  ['eslint', ['node_modules/eslint/bin/eslint.js', ...changed.filter(file => /\.tsx?$/.test(file)), '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
  ['stylelint', ['node_modules/stylelint/bin/stylelint.mjs', 'client/src/pages/MeetingManagement/meeting-action-edit.css', 'client/src/pages/MeetingManagement/weekly-images.css', 'client/src/pages/MeetingManagement/weekly-workbench.css']],
  ['isolated-client-compile', ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
];
const proof = { startedAt: new Date().toISOString(), passed: false, node: process.version, inputs: before, executions: [] };
try {
  for (const [name, args] of steps) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, MEETING_BROWSER_MODE: 'production' }, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(path.join(out, `${name}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
    proof.executions.push({ name, args, seconds: +((performance.now() - start)/1000).toFixed(3), exitCode: result.status, log: fingerprint(`output/weekly-workbench-validation-20261009/${name}.log`), tool: fingerprint(args[0]) });
    console.log(JSON.stringify(proof.executions.at(-1)));
    if (result.status !== 0 || result.error) throw new Error(`${name} failed`);
  }
  if (JSON.stringify(before) !== JSON.stringify(inputs.map(fingerprint))) throw new Error('验证过程中输入变化');
  proof.passed = true;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { proof.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'execution-proof.json'), JSON.stringify(proof, null, 2)); }
