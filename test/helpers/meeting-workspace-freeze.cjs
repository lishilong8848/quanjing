const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/meeting-sources-validation');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
const browser = read('output/meeting-sources-validation/browser-proof.json');
const weekly = read('output/weekly-workspace-validation/browser-proof.json');
const external = read('output/weekly-workspace-validation/real-integration.json');
const jest = read('output/meeting-sources-validation/jest-results.json');
if (!browser.passed || !weekly.passed || !external.passed || !jest.success || !Object.values(external.cleanup).every(Boolean)) throw new Error('证据不成立，禁止冻结');
const collect = (dir, expression) => fs.readdirSync(path.join(root, dir)).filter(name => expression.test(name)).map(name => `${dir}/${name}`);
const business = [
  ...collect('server/modules/meeting-management', /\.ts$/),
  ...collect('client/src/pages/MeetingManagement', /\.(tsx?|css)$/),
  ...collect('scripts/weekly-report', /\.py$/),
  'shared/meeting-management.interface.ts', 'shared/weekly-workspace.interface.ts', 'shared/weekly-workspace.rules.ts',
];
const sharedInputs = ['server/app.module.ts', 'client/src/app.tsx', 'client/src/navigation/page-switcher.ts', 'client/src/components/Layout.tsx', 'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx', 'server/common/feishu/bitable-direct-read.ts', 'shared/access-control.interface.ts', 'client/src/access/AccessProvider.tsx', 'client/src/components/GlobalNavigation.tsx', 'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json'];
const tools = ['test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser-entry.tsx', 'test/helpers/meeting-browser-fixture.cjs', 'test/helpers/meeting-browser.rspack.cjs', 'test/helpers/meeting-browser.css', 'test/helpers/meeting-additional-source-read.cjs', 'test/helpers/weekly-real-integration.cjs', 'test/helpers/meeting-workspace-freeze.cjs', 'test/visual/meeting-sources-browser.cjs', 'test/visual/weekly-workspace-browser.cjs', 'test/unit/meeting-management-model.spec.ts', 'test/unit/meeting-overview.spec.ts', 'test/unit/weekly-form-api.spec.ts'];
const docs = ['docs/engineering/release-handoff-2026-10-08-meeting-workspace-and-sources.md', 'docs/engineering/weekly-generator-review-2026-10-08.md', 'docs/superpowers/specs/2026-10-08-meeting-sources-design.md', 'docs/superpowers/specs/2026-10-08-weekly-workspace-design.md', 'docs/superpowers/plans/2026-10-08-weekly-workspace.md'];
const fingerprint = relative => ({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex') });
const proofs = ['output/meeting-sources-validation/browser-proof.json', 'output/meeting-sources-validation/jest-results.json', 'output/meeting-sources-validation/source-read.json', 'output/meeting-sources-validation/client.tsbuildinfo', 'output/meeting-sources-validation/server.tsbuildinfo', 'output/weekly-workspace-validation/browser-proof.json', 'output/weekly-workspace-validation/real-integration.json'];
const result = {
  state: 'source-frozen', generatedAt: new Date().toISOString(), node: process.version,
  sourceInputs: business.map(fingerprint), sharedInputs: sharedInputs.map(fingerprint), verificationTools: tools.map(fingerprint), documentation: docs.map(fingerprint), proofs: proofs.map(fingerprint),
  results: { jestSuites: jest.numPassedTestSuites, jestTests: jest.numPassedTests, clientTypes: 'exit0', serverTypes: 'exit0', pythonTests: 4, eslint: 'exit0; injectable-should-be-provided excluded; actual Nest DI passed', stylelint: 'exit0', isolatedCompileSeconds: 2.44, sourceBrowserChecks: browser.checks.length, weeklyBrowserChecks: weekly.checks.length, cachedDialogP95Ms: weekly.dialogFeedbackP95, sourceFilterMs: browser.localFeedbackMs, sources: browser.counts },
  evidenceReuse: '周会真实成功链路证据之后仅引擎超时退出/锁保护变化，当前定向测试补证；表单API/工作台组件未变，9项浏览器证据复用。最新6项来源浏览器覆盖最终分类、配色及来源隔离。共享入口后续变动须复核，不代表完整生产闭包。',
  cleanup: { isolatedPortsClosed: [4202, 4203], isolatedCachesRemoved: ['nt-meeting-source-bsUXbP', 'nt-meeting-source-39tdIE'], externalTestRowRemoved: external.cleanup.row, externalTestDocumentRemoved: external.cleanup.document, previewIntentionallyRunning: [4200, 4201], previewWriteProtected: true, earlierBlockedCacheKept: 'nt-meeting-source-BaGtPg' },
  release: { ownerThread: '01a05194-1697-7c73-a9ca-ce80b8cff3bc', formalBuild: false, package: false, deployed: false, oldSchedulerStillRunning: true, newSchedulerEnabled: false, templateLatestConfirmed: false },
};
fs.writeFileSync(path.join(out, 'freeze-manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, sourceFiles: business.length, sharedFiles: sharedInputs.length, tests: result.results.jestTests, browserChecks: browser.checks.length + weekly.checks.length }));
