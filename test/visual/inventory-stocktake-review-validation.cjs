// Development verification only; never creates a release build or package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  fingerprintSources,
} = require('../fixtures/inventory-stocktake-evidence.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-stocktake-review-check');
fs.mkdirSync(output, { recursive: true });
const step = process.argv[2];
const units = [
  'ui',
  'service',
  'source',
  'store',
  'api',
  'generation',
  'rules',
].map((name) => `test/unit/inventory-stocktake-${name}.spec.ts`);
units.push('test/unit/unified-access-guard.spec.ts');
function sourceFiles(dir) {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(`${dir}/${entry.name}`)
        : /\.(tsx?|css|json)$/.test(entry.name)
          ? [`${dir}/${entry.name}`]
          : [],
    );
}
const entries =
  step === 'types'
    ? ['client', 'server', 'shared'].flatMap(sourceFiles)
    : step === 'nest'
      ? ['test/integration/inventory-stocktake-module-di.cjs']
      : [...units];
entries.push(
  'test/visual/inventory-stocktake-review-validation.cjs',
  'client/src/pages/InventoryManagement/inventory-stocktake.css',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.app.json',
  'node_modules/typescript/lib/tsc.js',
);
const before = fingerprintSources(entries);
const commands =
  step === 'types'
    ? [
        [
          'node_modules/typescript/bin/tsc',
          '--noEmit',
          '--project',
          'tsconfig.node.json',
        ],
        [
          'node_modules/typescript/bin/tsc',
          '--noEmit',
          '--project',
          'tsconfig.app.json',
        ],
      ]
    : step === 'nest'
      ? [
          [
            'test/integration/inventory-stocktake-module-di.cjs',
            `--evidence-output=${path.join(output, 'nest-http.json')}`,
          ],
        ]
      : step === 'unit'
        ? [
            [
              'node_modules/jest/bin/jest.js',
              '--runInBand',
              '--runTestsByPath',
              ...units,
            ],
          ]
        : null;
if (!commands) throw new Error('Specify unit, types or nest');
const results = [];
for (const args of commands) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  const log = `${step}-${results.length + 1}.log`;
  fs.writeFileSync(
    path.join(output, log),
    `${result.stdout || ''}${result.stderr || ''}`,
  );
  results.push({
    command: `${process.execPath} ${args.join(' ')}`,
    exitCode: result.status,
    elapsedMs: Date.now() - started,
    log,
    error: result.error?.message,
  });
  if (result.status !== 0) break;
}
const drift = before.files.filter(
  (file) =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.resolve(root, file.path)))
      .digest('hex') !== file.sha256,
);
const evidence = {
  checkedAt: new Date().toISOString(),
  step,
  ...before,
  stable: !drift.length,
  drift,
  results,
};
const bytes = JSON.stringify(evidence, null, 2);
fs.writeFileSync(path.join(output, `${step}-final.json`), bytes);
console.log(
  JSON.stringify({
    step,
    inputs: before.files.length,
    stable: !drift.length,
    drift: drift.map((file) => file.path),
    results,
    evidenceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }),
);
if (drift.length || results.some((result) => result.exitCode !== 0))
  process.exitCode = 1;
