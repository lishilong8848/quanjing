// Development checks only. No production build, packaging, or external requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/equipment-ledger-permissions-check');
fs.mkdirSync(output, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inputs() {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx|json)$/u.test(entry.name)) files.push(file);
    }
  }
  for (const dir of ['client', 'server', 'shared']) visit(dir);
  files.push('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
    'node_modules/typescript/lib/tsc.js', 'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.app.json', 'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.node.json',
    'test/visual/equipment-ledger-permissions-validation.cjs',
    ...['equipment-ledger-access', 'equipment-ledger-classification', 'equipment-ledger-model', 'equipment-ledger-service', 'equipment-ledger-read-state', 'unified-access-guard', 'unified-access-policy'].map(name => `test/unit/${name}.spec.ts`),
    'test/integration/equipment-ledger-permissions.cjs');
  return files.sort().map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
}
const before = inputs();
const commands = [
  ['node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', ...['equipment-ledger-access', 'equipment-ledger-classification', 'equipment-ledger-model', 'equipment-ledger-service', 'equipment-ledger-read-state', 'unified-access-guard', 'unified-access-policy'].map(name => `test/unit/${name}.spec.ts`), '--json', `--outputFile=${path.join(output, 'unit-results.json')}`],
  ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.node.json'],
  ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json'],
];
const results = [];
for (const [index, command] of commands.entries()) {
  const start = Date.now();
  const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 120000 });
  const log = `check-${index}.log`;
  fs.writeFileSync(path.join(output, log), (result.stdout || '') + (result.stderr || ''));
  results.push({ command: `node ${command.join(' ')}`, exitCode: result.status, elapsedMs: Date.now() - start, log, logSha256: hash(fs.readFileSync(path.join(output, log))), error: result.error?.message });
  console.log(JSON.stringify(results.at(-1)));
  if (result.status !== 0) break;
}
const after = inputs();
const proof = { checkedAt: new Date().toISOString(), node: process.version, stable: hash(JSON.stringify(before)) === hash(JSON.stringify(after)), inputFingerprint: hash(JSON.stringify(before)), inputs: before, results };
const bytes = JSON.stringify(proof, null, 2);
const file = `verification-${hash(bytes)}.json`;
fs.writeFileSync(path.join(output, file), bytes, { flag: 'wx' });
console.log(JSON.stringify({ file, sha256: hash(bytes), stable: proof.stable }));
if (!proof.stable || results.length !== commands.length || results.some(result => result.exitCode !== 0)) process.exitCode = 1;
