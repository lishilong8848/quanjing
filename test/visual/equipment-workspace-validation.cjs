// Development verification only; does not build or package a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/equipment-ledger-20261003-check');
fs.mkdirSync(output, { recursive: true });
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function inputs() {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx|json)$/u.test(entry.name)) files.push(file);
    }
  }
  for (const dir of ['client', 'server', 'shared']) visit(dir);
  files.push(
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'node_modules/typescript/lib/tsc.js',
    'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.app.json',
    'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.node.json',
    'test/visual/equipment-workspace-validation.cjs',
  );
  return files.sort().map((file) => ({
    file,
    sha256: hash(fs.readFileSync(path.join(root, file))),
  }));
}
const before = inputs();
const results = [];
const configs =
  process.argv[2] === 'client-only'
    ? ['tsconfig.app.json']
    : ['tsconfig.node.json', 'tsconfig.app.json'];
for (const config of configs) {
  const started = Date.now();
  const command = [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--project',
    config,
  ];
  const result = spawnSync(process.execPath, command, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  fs.writeFileSync(
    path.join(output, `${config}.log`),
    (result.stdout || '') + (result.stderr || ''),
  );
  results.push({
    command: `node ${command.join(' ')}`,
    exitCode: result.status,
    elapsedMs: Date.now() - started,
    error: result.error?.message,
  });
  if (result.status !== 0) break;
}
const after = inputs();
const stable = hash(JSON.stringify(before)) === hash(JSON.stringify(after));
const evidence = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  stable,
  inputFingerprint: hash(JSON.stringify(before)),
  inputs: before,
  results,
};
fs.writeFileSync(
  path.join(
    output,
    configs.length === 1 ? 'type-client-final.json' : 'type-evidence.json',
  ),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({ stable, fingerprint: evidence.inputFingerprint, results }),
);
if (
  !stable ||
  results.length !== configs.length ||
  results.some((r) => r.exitCode !== 0)
)
  process.exitCode = 1;
