// Business verification only; never builds or packages a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => sha(fs.readFileSync(path.join(root, file)));
const direct = [
  'shared/today-operations-alarm-review.interface.ts',
  ...['AlarmReviewDialog.tsx', 'AlarmReviewPersonPicker.tsx', 'alarm-review-person-search.ts', 'alarm-review.css', 'AlarmTagAnomalyDialog.tsx'].map(file => `client/src/pages/TodayOperationsPanorama/${file}`),
  ...['alarm-review.rules.ts', 'alarm-review.gateway.ts', 'alarm-review.store.ts', 'alarm-review.service.ts', 'today-operations-alarm.service.ts'].map(file => `server/modules/bitable-sync/${file}`),
];
const tests = [
  ...['alarm-review.rules.spec.ts', 'alarm-review.gateway.spec.ts', 'alarm-review.store.spec.ts', 'alarm-review.service.spec.ts', 'today-operations-alarm.service.spec.ts', 'today-operations-alarm.controller.spec.ts'].map(file => `server/modules/bitable-sync/${file}`),
  'test/unit/alarm-review-person-search.spec.ts',
];
const sourceFiles = new Set();
function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw Error(`Source link not supported: ${file}`);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx|css|json)$/.test(file)) sourceFiles.add(file);
  }
}
for (const dir of ['client', 'server', 'shared']) walk(dir);
const configuration = ['package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json', 'jest.config.js', 'jest.config.cjs', 'jest.config.ts', 'tsconfig.json'];
for (const file of configuration) if (fs.existsSync(path.join(root, file))) sourceFiles.add(file);
const tools = ['node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/typescript.js', 'node_modules/typescript/package.json', 'node_modules/jest/bin/jest.js', 'node_modules/cmdk/package.json', 'node_modules/react/package.json', 'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.app.json', 'node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig/tsconfig.node.json', 'test/visual/alarm-review-custom-freeze.cjs'];
for (const file of tools) sourceFiles.add(file);
const snapshot = () => [...sourceFiles].sort().map(file => ({ file, sha256: fileHash(file) }));
const before = snapshot();
const beforeFingerprint = sha(JSON.stringify(before));
const started = new Date().toISOString();
const results = [];
for (const project of ['tsconfig.app.json', 'tsconfig.node.json']) {
  const start = performance.now();
  const args = ['node_modules/typescript/bin/tsc', '--noEmit', '--project', project];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  results.push({ command: [process.execPath, ...args], exitCode: result.status, durationMs: Math.round(performance.now() - start), stdout: result.stdout, stderr: result.stderr });
  if (result.status !== 0) throw Error(`${project} failed: ${result.stderr || result.stdout || result.error}`);
}
const after = snapshot();
if (sha(JSON.stringify(after)) !== beforeFingerprint) throw Error('Merged source changed during type checks');
const unitFile = 'output/alarm-review-custom-20261005-jest.json';
const units = JSON.parse(fs.readFileSync(path.join(root, unitFile), 'utf8'));
if (!units.success || units.numPassedTests !== 66 || units.numFailedTests !== 0) throw Error('Unit evidence invalid');
const artifactFiles = [unitFile, 'test/visual/alarm-human-review/config.cjs', 'test/visual/alarm-human-review/entry.tsx', 'test/visual/alarm-human-review/stubs.tsx', 'output/playwright/alarm-review-custom-desktop-final-20261005.png', 'output/playwright/alarm-review-custom-mobile-final-20261005.png', 'output/playwright/alarm-review-custom-narrow-accepted-20261005.png', 'output/playwright/alarm-review-custom-recovery-20261005.png'];
const evidence = {
  kind: 'business-source-handoff', status: 'source-frozen-external-schema-blocked',
  frozenAt: new Date().toISOString(), verificationStartedAt: started,
  releaseOwner: '01a05194-1697-7c73-a9ca-ce80b8cff3bc',
  productionBaselineReportedByOwner: '20261005-182903',
  productionBuildOrDeploymentPerformed: false, dependenciesOrEnvironmentChanged: false,
  node: { version: process.version, executable: process.execPath, sha256: sha(fs.readFileSync(process.execPath)) },
  directFiles: direct.map(file => ({ file, sha256: fileHash(file) })),
  testFiles: tests.map(file => ({ file, sha256: fileHash(file) })),
  typeChecks: { stable: true, inputFingerprint: beforeFingerprint, results, inputs: after },
  unitChecks: { suites: units.numPassedTestSuites, tests: units.numPassedTests, command: ['node v24.15.0', 'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', ...tests, '--json', '--outputFile', unitFile] },
  browser: { fixturePort: 39893, fixtureStopped: true, browserClosed: true, widths: [1440, 390, 320], maximumReplyCharacters: 500, directorySize: 1000, directoryReadsDuringSearch: 1, checks: ['partial-name and building/role matching', 'keyboard selection and Escape only dismisses expanded list', 'unknown typed name cannot submit', 'custom reply visible in parent list', 'double click produces one task', 'batch partial failure and failed-item retry', 'lost submit response recovered with original custom reply and person', 'fixed header/footer and no horizontal overflow'], limitations: ['Isolated API adapter, not real external record write', 'No production performance measurement'], expectedConsoleErrors: ['fixture favicon 404', 'deliberately simulated submit 503 in lost-response case'] },
  artifacts: artifactFiles.map(file => ({ file, sha256: fileHash(file) })),
  externalSchema: { state: 'awaiting-explicit-user-approval', tableId: 'tbld976fa6fc1832', changes: ['append 自定义回复 to 人工复核结果 without changing old options', 'create text field 复核回复 and show it in 异常人工复核 view'], realWriteVerified: false, blocksDeployment: true, reason: 'Gateway preflight requires four result options and the text reply field; without them even preset review submissions are rejected. Do not publish this feature before approval, schema readback and external-write acceptance.' },
  validity: 'Any source, fixture, compiler/configuration, dependency or Node drift invalidates affected evidence. Existing production freeze is preserved. This is not deployment readiness or production acceptance.',
};
const output = path.join(root, 'docs/engineering/alarm-review-custom-freeze-2026-10-05.json');
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output, sha256: sha(fs.readFileSync(output)), directFiles: direct.length, typeInputs: after.length, fingerprint: beforeFingerprint, results: results.map(r => ({ exitCode: r.exitCode, durationMs: r.durationMs })) }));
