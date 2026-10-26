const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/meeting-management-validation');
const read = (name) => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8').replace(/^\uFEFF/, ''));
const browser = read('browser-proof.json');
const performance = read('performance-proof.json');
const types = read('typecheck-client.json');
if (!browser.passed || performance.mode !== 'production' || performance.p95 > 150 || performance.filterP95 > 100 || types.exitCode !== 0) {
  throw new Error('验证证据不成立，禁止写冻结清单');
}
const directories = ['server/modules/meeting-management', 'client/src/pages/MeetingManagement'];
const files = [
  ...directories.flatMap((dir) => fs.readdirSync(path.join(root, dir)).map(name => `${dir}/${name}`)),
  'shared/meeting-management.interface.ts', 'server/app.module.ts',
  'client/src/app.tsx', 'client/src/components/Layout.tsx', 'client/src/navigation/page-switcher.ts',
  'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
  'server/common/feishu/bitable-direct-read.ts', 'shared/access-control.interface.ts',
  'client/src/access/AccessProvider.tsx', 'client/src/components/GlobalNavigation.tsx',
  'test/unit/page-switcher.spec.ts', 'test/unit/meeting-management-model.spec.ts',
  'test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser-entry.tsx',
  'test/helpers/meeting-browser-fixture.cjs', 'test/helpers/meeting-browser.rspack.cjs',
  'test/helpers/meeting-browser.css', 'test/visual/meeting-management-browser.cjs',
  'test/visual/meeting-performance.cjs', 'test/helpers/meeting-verification-manifest.cjs',
  'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'docs/engineering/release-handoff-2026-10-08-meeting-management.md',
];
const fingerprint = (relative) => ({
  path: relative,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'),
});
const evidence = {
  generatedAt: new Date().toISOString(), node: process.version, state: 'source-frozen',
  sourceInputs: files.map(fingerprint),
  proofs: ['browser-proof.json', 'performance-proof.json', 'typecheck-client.json', 'source-read.json']
    .map(name => fingerprint(`output/meeting-management-validation/${name}`)),
  results: { jestSuites: 5, jestTests: 33, jestSeconds: 19.284, clientTypes: types,
    serverTypes: 'passed before final verification; task backend unchanged',
    eslint: 'passed with only injectable-should-be-provided excluded; real Nest DI passed',
    stylelint: 'passed', browserChecks: browser.checks.length,
    cachedDialogP95: performance.p95, scopeFilterP95: performance.filterP95,
    largeSearchMs: browser.timings.largeSearchLocalMs },
  validity: '本任务业务源码及相关共享入口/适配器/依赖/工具输入不变；后续相关改动必须复核对应哈希及证据。不是完整发布闭包证明。',
  release: { formalBuild: false, package: false, deployed: false,
    ownerThread: '01a05194-1697-7c73-a9ca-ce80b8cff3bc' },
  cleanup: { portsClosed: [4200, 4201], currentTemporaryCacheRemoved: true,
    previousTemporaryCacheRemoved: false, bytesRemaining: 257656,
    pathRemaining: 'C:\\Users\\36056\\AppData\\Local\\Temp\\nt-meeting-source-BaGtPg',
    reason: 'explicit absolute-path delete rejected: blocked by policy' },
};
fs.writeFileSync(path.join(output, 'verification-manifest.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ state: evidence.state, inputs: files.length, checks: browser.checks.length,
  cachedDialogP95: performance.p95, filterP95: performance.filterP95, cleanupComplete: false }));
