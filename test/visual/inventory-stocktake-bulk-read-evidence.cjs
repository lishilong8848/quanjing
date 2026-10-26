const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-stocktake-bulk-check-20261016');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const productionFiles = ['inventory-workflow.gateway.ts', 'inventory-stocktake.source.ts', 'inventory-stocktake.service.ts'].map(name => `server/modules/inventory-management/${name}`);
const inputs = require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources([
  ...productionFiles,
  ...['inventory-stocktake-read-timeout', 'inventory-stocktake-source', 'inventory-stocktake-service', 'inventory-stocktake-bulk', 'inventory-workflow-gateway'].map(name => `test/unit/${name}.spec.ts`),
  'test/visual/inventory-stocktake-dev-server.cjs', 'test/visual/inventory-stocktake-bulk-read-probe.cjs',
  'test/visual/inventory-stocktake-bulk-read-evidence.cjs', 'test/fixtures/inventory-stocktake-browser/entry.tsx',
  'test/fixtures/inventory-stocktake-browser/performance.ts', 'test/fixtures/inventory-stocktake-browser/styles.css',
  'test/fixtures/inventory-stocktake-evidence.cjs', 'client/src/tailwind-theme.css', 'tsconfig.json',
]);
const tsPath = path.join(root, 'dist/tsconfig.node.tsbuildinfo');
const build = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
const typeInputs = build.fileNames.flatMap((name, index) => {
  const file = path.resolve(path.dirname(tsPath), name);
  const relative = path.relative(root, file).replace(/\\/g, '/');
  if (!/^(server|shared)\//.test(relative)) return [];
  const info = build.fileInfos[index];
  const version = typeof info === 'string' ? info : info.version;
  const currentSha256 = hash(file);
  return [{ path: relative, compiledVersion: version, currentSha256, matches: version === currentSha256 }];
});
const ledgerPath = path.join(output, 'browser/fixture-ledger.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const sheet = ledger.sheets.find(sheet => sheet.month === '2026-10' && sheet.building === 'B楼').review;
const batch = ledger.bulkBatches[0];
const browser = {
  externalWrites: 0, jobs: ledger.bulkJobs.map(({ id, status, attempts, count, request }) => ({ id, status, attempts, count, requestCleared: request === null })),
  batches: ledger.bulkBatches.length, batchStatus: batch.status, batchCount: batch.count,
  draftLines: sheet.lines.filter(line => line.status === 'draft').length,
  zero: sheet.lines.find(line => line.inventory.recordId === 'test-B楼-1')?.actualQuantity,
  note: sheet.lines.find(line => line.inventory.recordId === 'test-B楼-1')?.note,
  reads: JSON.parse(fs.readFileSync(path.join(output, 'browser/bulk-reads.json'), 'utf8')),
  actions: JSON.parse(fs.readFileSync(path.join(output, 'browser/actions.json'), 'utf8')),
  limitations: ['Old feedback observer requires 正在确认 or role=alert; current queued/running feedback uses other visible states. Two false observations (1001.3ms,1012.2ms) retained; no P95 compliance claim.', 'After reload and completion, route defaults to A楼; B楼 was explicitly selected to inspect undo. No navigation changes made.'],
};
if (browser.jobs.length !== 1 || browser.jobs[0].attempts !== 2 || browser.batches !== 1 || browser.batchStatus !== 'undone' || browser.batchCount !== 400 || browser.draftLines !== 400 || browser.zero !== 0) throw new Error('Browser ledger verification failed');
fs.writeFileSync(path.join(output, 'browser/ledger-summary.json'), JSON.stringify(browser, null, 2));
const files = ['read-probe.json', 'read-probe-targeted.json', 'red.log', 'green.log', 'recheck.log', 'types.log',
  'browser/bulk-reads.json', 'browser/actions.json', 'browser/ledger-summary.json', 'browser/fixture-ledger.json',
  'browser/error.png', 'browser/error.txt', 'browser/success.png', 'browser/success-terminal.png', 'browser/success.txt', 'browser/undo.png', 'browser/undo.txt'];
const proof = {
  generatedAt: new Date().toISOString(), status: 'SourceFrozen', productionFiles,
  inputs, executable: { node: process.version, nodeSha256: hash(process.execPath), typescript: require('typescript/package.json').version, jest: require('jest/package.json').version },
  tests: { finalSuites: 5, aggregatePassed: 133, initialGreenRun: '4 suites /117 tests; one fixture expectation failed;3 suites116 tests passed', recheck: '3 suites22 tests passed, includes two added boundary tests and14 service tests',
    commands: [
      'node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/unit/inventory-stocktake-read-timeout.spec.ts',
      'node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/unit/inventory-stocktake-read-timeout.spec.ts test/unit/inventory-stocktake-source.spec.ts test/unit/inventory-stocktake-bulk.spec.ts test/unit/inventory-workflow-gateway.spec.ts',
      'node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/unit/inventory-stocktake-source.spec.ts test/unit/inventory-stocktake-read-timeout.spec.ts test/unit/inventory-stocktake-service.spec.ts',
    ] },
  types: { command: 'node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json', exitCode: 0,
    actualBuildInfoSha256: hash(tsPath), actualBuildInfoTime: fs.statSync(tsPath).mtime.toISOString(), typeInputs,
    limitations: 'No independent pre-run complete input manifest was captured. This verifies the compiler-recorded versions against current application source; it does not reconstruct an original before manifest or prove unchanged tool/config inputs before execution. Later shared/backend changes invalidate affected evidence; final integrated type check is publisher coordinated.' },
  readonlyProbe: { original: 'Full-table pagination exhausted 30s and timed out', targeted: '400 B楼 rows verified in4 x100 batch_get; no external writes',
    originalSuccessfulPersonnelStageTimingBug: 'elapsedMs was evaluated before await and recorded0; original request timings remain valid and file unchanged. Fixed only in subsequent targeted run.',
    note: 'Two different-time read snapshots; not a same-snapshot benchmark or production confirmation result.' },
  browser,
  runtimeCleanup: { processSessionsEnded: [87479,64072,97064,3059,2451], browserTabClosed: true, serverPort: 60900, serverListening: false, privateCacheRemoved: true, syntheticLedgerRetainedAsEvidence: true },
  noProductionBuildPackageInstallOrWrite: true,
  artifacts: files.map(file => ({ path: file, sha256: hash(path.join(output, file)) })),
};
fs.writeFileSync(path.join(output, 'source-freeze.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ inputs: inputs.files.length, typeApplicationInputs: typeInputs.length, typeDrift: typeInputs.filter(file => !file.matches).map(file => file.path), productionFiles: productionFiles.map(file => ({ path: file, sha256: hash(path.join(root,file)) })), freezeSha256: hash(path.join(output,'source-freeze.json')) }));
