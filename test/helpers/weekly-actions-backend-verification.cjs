const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/weekly-actions-validation-20261009');
const hash = name => ({ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') });
const original = JSON.parse(fs.readFileSync(path.join(out, 'execution-proof.json')));
if (!original.passed) throw new Error('原前端证明未通过');
const reused = original.inputs.filter(file => !file.path.startsWith('server/modules/meeting-management/'));
for (const file of reused) if (hash(file.path).sha256 !== file.sha256) throw new Error(`复用输入变化：${file.path}`);
const sources = fs.readdirSync(path.join(root, 'server/modules/meeting-management')).filter(name => name.endsWith('.ts')).map(name => `server/modules/meeting-management/${name}`);
const inputs = [...sources, 'shared/weekly-workspace.interface.ts', 'shared/weekly-workspace.rules.ts', 'shared/meeting-management.interface.ts', 'test/helpers/weekly-actions-backend-verification.cjs', 'test/jest.meeting-management.config.cjs', 'package.json', 'package-lock.json', 'tsconfig.node.json'].map(hash);
const proof = { startedAt: new Date().toISOString(), passed: false, inputs, reused, originalProof: hash('output/weekly-actions-validation-20261009/execution-proof.json'), executions: [] };
const steps = [
  ['backend-tests', ['node_modules/jest/bin/jest.js', '--config', 'test/jest.meeting-management.config.cjs', '--runInBand', 'server/modules/meeting-management', '--json', '--outputFile', path.join(out, 'backend-jest-results.json')]],
  ['server-types-final', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json']],
  ['backend-eslint-final', ['node_modules/eslint/bin/eslint.js', ...sources.filter(name => !name.endsWith('.spec.ts')), '--rule', '@darraghor/nestjs-typed/injectable-should-be-provided: off']],
];
try {
  for (const [name, args] of steps) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(path.join(out, `${name}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
    proof.executions.push({ name, args, exitCode: result.status, seconds: +((performance.now() - start)/1000).toFixed(3), log: hash(`output/weekly-actions-validation-20261009/${name}.log`), tool: hash(args[0]) });
    console.log(JSON.stringify({ name, exitCode: result.status, seconds: proof.executions.at(-1).seconds }));
    if (result.status !== 0 || result.error) throw new Error(`${name} failed`);
  }
  for (const file of [...inputs, ...reused]) if (hash(file.path).sha256 !== file.sha256) throw new Error('验证期间输入变化');
  proof.passed = true;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { proof.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'backend-execution-proof.json'), JSON.stringify(proof, null, 2)); }
