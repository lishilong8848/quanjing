const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fingerprintSources } = require('./inventory-stocktake-evidence.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-movement-specialty-regression-check');
const changedFiles = [
  'client/src/pages/InventoryManagement/inventory-inbound-recovery.ts',
  'client/src/pages/InventoryManagement/inventory-outbound-recovery.ts',
  'client/src/pages/InventoryManagement/inventory-outbound-creation-task.ts',
  'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
  'test/unit/inventory-inbound-recovery.spec.ts',
  'test/unit/inventory-outbound-creation-task.spec.ts',
  'test/unit/inventory-movement-entry-ui.spec.ts',
  'test/unit/inventory-outbound-confirmation-ui.spec.ts',
  'test/fixtures/inventory-movement-specialty-browser/entry.tsx',
  'test/fixtures/inventory-movement-specialty-browser/api.ts',
  'test/visual/inventory-movement-specialty-dev-server.cjs',
  'test/fixtures/inventory-movement-specialty-evidence.cjs',
];
const suites = [
  'inventory-inbound-recovery', 'inventory-outbound-recovery', 'inventory-outbound-creation-task',
  'inventory-outbound-creation-runtime', 'inventory-outbound-creation-coordinator', 'inventory-outbound-creation-ui',
  'inventory-inbound-accepted-recovery-ui', 'inventory-inbound-task-reconciliation-coordinator', 'inventory-inbound-optimistic',
  'inventory-movement-entry-ui', 'inventory-outbound-confirmation-ui', 'inventory-movement-command-rules', 'inventory-management-api',
].map(name => `test/unit/${name}.spec.ts`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readLog = file => {
  const bytes = fs.readFileSync(path.join(output, file));
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
};
const initialLog = readLog('unit.log');
const retryLog = readLog('unit-recheck.log');
if (!initialLog.includes('10 passed, 13 total') || !retryLog.includes('116 passed, 116 total')) throw new Error('Unit evidence incomplete');
const success = JSON.parse(fs.readFileSync(path.join(output, 'browser/success-requests.json'), 'utf8'));
if (success.externalWrites !== 0 || success.requests.length !== 2 || success.tasks.some(task => task.status !== 'completed')) throw new Error('Browser submission evidence incomplete');
if (sha(path.join(output, 'browser/requests.json')) !== sha(path.join(output, 'browser/success-requests.json'))) throw new Error('Storage failure unexpectedly sent a request');
const inputs = fingerprintSources([...changedFiles, ...suites, 'test/fixtures/inventory-stocktake-evidence.cjs',
  'test/fixtures/inventory-stocktake-browser/styles.css', 'client/src/tailwind-theme.css', 'tsconfig.json',
]);
const evidenceFiles = ['red.json', 'green.json', 'unit.log', 'unit-recheck.log', 'types.log',
  'browser/success-requests.json', 'browser/requests.json', 'browser/inbound.txt', 'browser/outbound.txt',
  'browser/storage-rejected.txt', 'browser/inbound.png', 'browser/outbound.png', 'browser/storage-rejected.png'];
const evidence = {
  generatedAt: new Date().toISOString(), status: 'source-frozen-for-next-package',
  productionBuildOrPackageCreated: false, releaseOwner: '01a05194-1697-7c73-a9ca-ce80b8cff3bc',
  excludedCurrentCandidate: '20261011-073034',
  changedFiles, inputs, nodeExecutableSha256: sha(process.execPath),
  toolVersions: Object.fromEntries(['jest', 'typescript', '@rspack/core', 'prettier'].map(name => [name, require(`${name}/package.json`).version])),
  checks: {
    unit: { suites: 13, passed: 364, firstRound: '10 suites passed; 3 suites required correction', recheck: '3 suites / 116 tests passed',
      firstCommand: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath ${suites.join(' ')}`,
      recheckCommand: 'node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/unit/inventory-outbound-creation-task.spec.ts test/unit/inventory-movement-entry-ui.spec.ts test/unit/inventory-outbound-confirmation-ui.spec.ts',
      causes: ['New test omitted awaiting the async journal reader', 'Pure form helper test lacked a mock for the new AccessProvider import', 'Old confirmation UI assertion predated building_admin scope'],
    },
    types: { command: 'node node_modules/typescript/bin/tsc --noEmit --project tsconfig.app.json', exitCode: 0, elapsedSeconds: 43.5296118 },
    browser: { command: 'node test/visual/inventory-movement-specialty-dev-server.cjs', browser: 'Codex In-app Browser / CUA',
      actualFrontend: true, syntheticBackend: true, externalWrites: 0,
      cases: ['E楼 A1118 inbound quantity 2 accepted and recovered after refresh', 'D楼 D1002 outbound quantity 3 accepted and recovered after refresh', 'Storage rejection blocks outbound request and retains the complete form'],
      postCount: 2, uniqueClientMutationIds: new Set(success.requests.map(request => request.input.clientMutationId)).size,
      cleanup: { cache: 'fixture cleanup button executed', tab: 'closed', server: 'stopped', port: 5198, portReleased: true },
    },
    static: { diffCheck: 'passed', fixtureSyntax: 'passed' },
  },
  reuseCondition: 'Recheck SHA-256 for the affected source closure, tool/configuration/lock inputs, and evidence artifacts; invalidate affected evidence on any change. Production build/install remain release-owner duties.',
  artifacts: evidenceFiles.map(file => ({ path: file, sha256: sha(path.join(output, file)) })),
};
const target = path.join(output, 'source-freeze.json');
fs.writeFileSync(target, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ sourceFreeze: path.relative(root, target), sha256: sha(target), inputFiles: inputs.files.length, unitPassed: 364, browserPostCount: 2 }));
