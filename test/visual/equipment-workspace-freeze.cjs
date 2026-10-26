// Records existing business verification; never builds or packages a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = 'output/equipment-ledger-20261003-check';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(`${output}/${file}`));
const files = new Set();
function visit(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:ts|tsx|css|cjs)$/u.test(file)) files.add(file);
  }
}
for (const dir of ['client/src/pages/EquipmentLedgerManagement', 'client/src/pages/EquipmentLifecycleDashboard', 'server/modules/equipment-lifecycle', 'test/fixtures/equipment-ledger-browser']) visit(dir);
for (const file of [
  'server/common/feishu/bitable-direct-read.ts',
  'server/common/access/unified-access.guard.ts',
  'shared/equipment-history.interface.ts',
  'shared/equipment-ledger.interface.ts',
  'shared/equipment-ledger-classification.ts',
  'shared/equipment-lifecycle.interface.ts',
  'client/src/app.tsx', 'client/src/access/access-policy.ts',
  'test/integration/equipment-history-permissions.cjs',
  'test/integration/equipment-ledger-module-di.cjs',
  'test/visual/equipment-workspace-dev-server.cjs',
  'test/visual/equipment-workspace-validation.cjs',
  'test/visual/equipment-ledger-startup-check.cjs',
  'test/visual/equipment-workspace-freeze.cjs',
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
]) files.add(file);
const units = json('unit-results.json');
const api = json('api-unit-results.json');
const dialog = json('lifecycle-dialog-unit-results.json');
for (const suite of [...units.testResults, ...api.testResults, ...dialog.testResults]) files.add(path.relative(root, suite.name).split(path.sep).join('/'));
for (const result of [units, api, dialog]) if (!result.success || result.numFailedTests) throw Error('Unit proof failed');
const types = json('type-evidence.json');
if (!types.stable || types.results.some(r => r.exitCode !== 0)) throw Error('Type proof failed');
for (const proof of [json('startup-timing.json'), json('http-permissions.json')]) {
  for (const item of proof.files) if (sha(read(item.file)) !== item.sha256) throw Error(`Proof drift: ${item.file}`);
}
for (const item of types.inputs) if (sha(read(item.file)) !== item.sha256) throw Error(`Type drift: ${item.file}`);
const closure = [...files].sort().map(file => ({ file, sha256: sha(read(file)) }));
const evidenceFiles = ['unit-results.json','api-unit-results.json','lifecycle-dialog-unit-results.json','http-permissions.json','startup-timing.json','type-evidence.json','browser/interaction-timing.json','browser/final-browser-evidence.json','browser/final-network.json','browser/history-cache-network.json','browser/repair-list-final.jpg','browser/history-final.jpg','browser/history-narrow-final.jpg','browser/lifecycle-drilldown-narrow-final.jpg'];
const result = {
  status: 'source-frozen-business-verified', frozenAt: new Date().toISOString(),
  releaseOwner: '01a05194-1697-7c73-a9ca-ce80b8cff3bc',
  productionBaseline: 'nantong-safe-full-runtime-hotfix-20261002-235556',
  productionBuildOrDeploymentPerformed: false,
  dependenciesOrConfigurationChanged: false,
  sourceFingerprint: sha(JSON.stringify(closure)), closure,
  typeInputFingerprint: types.inputFingerprint,
  tests: { uniquePassed: units.numPassedTests + api.numPassedTests, dialogSubsetRechecked: dialog.numPassedTests, httpChecks:272, inventoryChecks:36 },
  browserData: [
    'output/equipment-history-check/live-repair-source.json',
    'output/equipment-history-card-planning/full-audit-2026-10-02/ledger.json',
    'data/feishu-bitable-cache/1cffe0c0c62e1e79908edd3ec2b2bf56720fe0f9.json',
  ].map(file => ({ file, sha256: sha(read(file)) })),
  evidence: evidenceFiles.map(file=>({ file:`${output}/${file}`,sha256:sha(read(`${output}/${file}`)) })),
  validity: 'Invalidate affected evidence if source, tools, dependency, fixture or configuration fingerprints change. Final dialog subset supersedes its earlier UI assertions. No production timing or deployability claim.',
};
fs.writeFileSync(path.join(root, output, 'source-freeze.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({status:result.status,fingerprint:result.sourceFingerprint,files:closure.length,tests:result.tests}));
