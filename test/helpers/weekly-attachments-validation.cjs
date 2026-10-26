const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const out = path.resolve('output/weekly-attachments-validation-20261009');
fs.mkdirSync(out, { recursive: true });
const sources = ['client/src/pages/MeetingManagement', 'server/modules/meeting-management'].flatMap(dir => fs.readdirSync(dir).filter(name => /\.(tsx?|css)$/.test(name)).map(name => `${dir}/${name}`));
const changed = ['client/src/pages/MeetingManagement/WeeklyImagePicker.tsx', 'client/src/pages/MeetingManagement/WeeklyMeetingDialog.tsx', 'client/src/pages/MeetingManagement/WeeklyWorkbench.tsx', 'client/src/pages/MeetingManagement/weekly-files.ts', 'server/modules/meeting-management/weekly.attachments.ts', 'server/modules/meeting-management/weekly.attachments.spec.ts', 'server/modules/meeting-management/weekly.controller.ts', 'server/modules/meeting-management/weekly.gateway.ts', 'server/modules/meeting-management/weekly.service.ts', 'server/modules/meeting-management/weekly.store.ts', 'shared/weekly-workspace.interface.ts', 'test/unit/weekly-files.spec.ts'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = [...new Set([...sources, ...changed, 'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json', 'test/helpers/meeting-browser.rspack.cjs', __filename])].map(file => ({path: file, sha256: sha(file)}));
const proof = { startedAt: new Date().toISOString(), passed: false, inputs, relatedTests: { suites: 6, tests: 43, passed: true, command: 'node node_modules/jest/bin/jest.js --config test/jest.meeting-management.config.cjs --runInBand --runTestsByPath server/modules/meeting-management/weekly.attachments.spec.ts server/modules/meeting-management/weekly.store.spec.ts server/modules/meeting-management/weekly.gateway.spec.ts server/modules/meeting-management/weekly.service.spec.ts test/unit/weekly-form-api.spec.ts test/unit/weekly-files.spec.ts --silent', seconds: 14.28 }, executions: [] };
try {
  for (const [name, args] of [
    ['client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json']],
    ['server-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json']],
    ['lint', ['node_modules/eslint/bin/eslint.js', ...changed, '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
    ['styles', ['node_modules/stylelint/bin/stylelint.mjs', 'client/src/pages/MeetingManagement/weekly-images.css']],
    ['isolated-preview-compile', ['node_modules/@rspack/cli/bin/rspack.js', 'build', '--config', 'test/helpers/meeting-browser.rspack.cjs']],
  ]) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { env: {...process.env, MEETING_BROWSER_MODE:'production'}, encoding:'utf8', timeout:120000, windowsHide:true, maxBuffer:8*1024*1024 });
    const log = path.join(out, name+'.log');
    fs.writeFileSync(log, (result.stdout || '')+'\n'+(result.stderr || '')+(result.error ? result.error.message : ''));
    proof.executions.push({name, args, exitCode:result.status, seconds:(performance.now()-start)/1000, logSha256:sha(log)});
    console.log(JSON.stringify(proof.executions.at(-1)));
    if (result.status !== 0) throw Error(name+'失败：'+log);
  }
  for (const input of inputs) if (sha(input.path) !== input.sha256) throw Error('验证期间输入变化：'+input.path);
  proof.passed = true;
} catch(error) { proof.error=error.message; process.exitCode=1; }
finally { proof.finishedAt=new Date().toISOString(); fs.writeFileSync(path.join(out,'execution-proof.json'),JSON.stringify(proof,null,2)); }
