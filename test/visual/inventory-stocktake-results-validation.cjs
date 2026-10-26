// Related business checks only. No release build, staging, install or package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  fingerprintSources,
} = require('../fixtures/inventory-stocktake-evidence.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-stocktake-results-check');
fs.mkdirSync(output, { recursive: true });
const step = process.argv[2];
const units = [
  'service',
  'results',
  'results-gateway',
  'store',
  'api',
  'ui',
  'generation',
  'rules',
  'source',
].map((name) => `test/unit/inventory-stocktake-${name}.spec.ts`);
units.push('test/unit/unified-access-guard.spec.ts');
function files(dir) {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(`${dir}/${e.name}`)
        : /\.(tsx?|css|json)$/.test(e.name)
          ? [`${dir}/${e.name}`]
          : [],
    );
}
const entries =
  step === 'types'
    ? ['server', 'client', 'shared'].flatMap(files)
    : step === 'nest'
      ? ['test/integration/inventory-stocktake-module-di.cjs']
      : [...units];
entries.push(
  'test/visual/inventory-stocktake-results-validation.cjs',
  '.env.example',
  'scripts/configure-stocktake-results-table.mjs',
  'node_modules/typescript/lib/tsc.js',
);
const before = fingerprintSources(entries);
const commands =
  step === 'unit'
    ? [
        [
          'node_modules/jest/bin/jest.js',
          '--runInBand',
          '--runTestsByPath',
          ...units,
        ],
      ]
    : step === 'types'
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
        : null;
if (!commands) throw new Error('Specify unit, types or nest');
const results = [];
for (const args of commands) {
  const start = Date.now();
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
    command: `node ${args.join(' ')}`,
    exitCode: result.status,
    elapsedMs: Date.now() - start,
    log,
  });
  if (result.status !== 0) break;
}
const drift = before.files
  .filter(
    (f) =>
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, f.path)))
        .digest('hex') !== f.sha256,
  )
  .map((f) => f.path);
const passed =
  !drift.length &&
  results.length === commands.length &&
  results.every((r) => r.exitCode === 0);
fs.writeFileSync(
  path.join(output, `${step}-final.json`),
  JSON.stringify(
    {
      passed,
      checkedAt: new Date().toISOString(),
      results,
      drift,
      inputs: before,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    step,
    passed,
    results,
    drift,
    inputCount: before.files.length,
  }),
);
if (!passed) process.exitCode = 1;
