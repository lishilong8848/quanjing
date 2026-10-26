// Development evidence only; does not build or package a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-stocktake-r2-check');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const prior = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      'output/equipment-ledger-revision-3-check/type-evidence.json',
    ),
    'utf8',
  ),
);
const before = prior.inputs.map(({ file }) => ({
  file,
  sha256: hash(fs.readFileSync(path.join(root, file))),
}));
const changed = before.filter(
  (input, index) => input.sha256 !== prior.inputs[index].sha256,
);
const allowed = new Set([
  'client/src/pages/InventoryManagement/InventoryStocktakePage.tsx',
  'client/src/pages/InventoryManagement/inventory-stocktake.logic.ts',
  'test/visual/equipment-ledger-r3-validation.cjs',
]);
if (
  !prior.stable ||
  prior.results.some((r) => r.exitCode !== 0) ||
  changed.some((input) => !allowed.has(input.file))
) {
  throw new Error('Prior type proof drift exceeds the two frontend changes');
}
before.push({
  file: 'test/visual/inventory-stocktake-r2-validation.cjs',
  sha256: hash(fs.readFileSync(__filename)),
});
const reuseServer = changed.every((input) => input.file.startsWith('client/'));
const results = [];
for (const config of reuseServer
  ? ['tsconfig.app.json']
  : ['tsconfig.node.json', 'tsconfig.app.json']) {
  const command = [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--project',
    config,
  ];
  const started = Date.now();
  const result = spawnSync(process.execPath, command, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  fs.writeFileSync(
    path.join(output, `${config}-final.log`),
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
const stable = before.every(
  ({ file, sha256 }) => hash(fs.readFileSync(path.join(root, file))) === sha256,
);
const evidence = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  stable,
  priorEvidence: 'output/equipment-ledger-revision-3-check/type-evidence.json',
  priorEvidenceSha256: hash(
    fs.readFileSync(
      path.join(
        root,
        'output/equipment-ledger-revision-3-check/type-evidence.json',
      ),
    ),
  ),
  serverProofReused: reuseServer ? prior.results[0] : null,
  reuseFailure: reuseServer ? null : 'Prior verification runner bytes changed',
  changed,
  inputs: before,
  results,
};
fs.writeFileSync(
  path.join(output, 'type-final.json'),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    stable,
    changed: changed.map((i) => i.file),
    results,
  }),
);
if (!stable || results.some((r) => r.exitCode !== 0)) process.exitCode = 1;
