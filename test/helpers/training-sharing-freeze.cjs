const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const out = 'output/training-sharing-validation-20261009';
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const fingerprint = file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') });
const priorPath = 'output/meeting-overview-refresh-20261009/freeze-manifest.json';
const originalPath = 'output/meeting-sources-validation/freeze-manifest.json';
const prior = read(priorPath), original = read(originalPath);
const browser = read(`${out}/browser-proof.json`), execution = read(`${out}/execution-proof.json`), jest = read(`${out}/jest-results.json`);
if (!browser.passed || !execution.passed || !jest.success) throw new Error('新鲜验证未通过，不可冻结');
for (const item of execution.sourceInputs) if (fingerprint(item.path).sha256 !== item.sha256) throw new Error(`验证后输入漂移：${item.path}`);
const delta = ['client/src/pages/MeetingManagement/MeetingSourceBoard.tsx', 'client/src/pages/MeetingManagement/model.ts'];
const drift = (items) => items.filter(item => fingerprint(item.path).sha256 !== item.sha256).map(item => item.path);
const businessDrift = drift(prior.sourceInputs);
if (businessDrift.some(file => !delta.includes(file))) throw new Error(`存在其它业务漂移：${businessDrift.join(', ')}`);
const added = ['TrainingSharingBoard.tsx', 'TrainingSharingPanels.tsx', 'training-model.ts', 'training-sharing.css'].map(file => `client/src/pages/MeetingManagement/${file}`);
const tools = ['test/unit/training-sharing-model.spec.ts', 'test/unit/meeting-management-model.spec.ts', 'test/visual/training-sharing-browser.cjs', 'test/helpers/training-sharing-verification.cjs', 'test/helpers/training-sharing-freeze.cjs', 'test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser.rspack.cjs', 'test/helpers/meeting-browser-entry.tsx', 'test/helpers/meeting-browser-fixture.cjs', 'test/helpers/meeting-browser.css', 'eslint.config.js', '.stylelintrc.js', '.prettierrc'];
const proofs = ['browser-proof.json', 'execution-proof.json', 'jest-results.json', 'client.tsbuildinfo', 'training-desktop.png', 'training-mobile.png', ...execution.executions.map(e => e.log.path.slice(out.length + 1))].map(file => `${out}/${file}`);
const reused = [...prior.proofs.filter(item => /browser-proof|desktop.png|mobile.png/.test(item.path)), ...original.proofs.filter(item => /weekly-workspace-validation|server.tsbuildinfo|source-read/.test(item.path))];
for (const item of reused) if (fingerprint(item.path).sha256 !== item.sha256) throw new Error(`旧证据字节发生变化：${item.path}`);
const manifest = {
  state: 'source-frozen', generatedAt: new Date().toISOString(), node: process.version,
  predecessor: fingerprint(priorPath), originalMeetingFreeze: fingerprint(originalPath),
  delta: [...delta, ...added].map(fingerprint), sourceInputs: [...prior.sourceInputs.map(item => item.path), ...added].map(fingerprint),
  sharedInputs: prior.sharedInputs.map(item => fingerprint(item.path)), sharedDriftSincePredecessor: drift(prior.sharedInputs),
  verificationTools: tools.map(fingerprint), documentation: fingerprint('docs/engineering/release-handoff-2026-10-09-training-sharing.md'), proofs: proofs.map(fingerprint),
  reusedProofs: reused,
  results: { jestSuites: jest.numPassedTestSuites, jestTests: jest.numPassedTests, browserChecks: browser.checks.length, pageErrors: browser.errors, metrics: browser.metrics, filterP95Ms: browser.filterP95Ms, executions: execution.executions.map(({ name, exitCode, seconds }) => ({ name, exitCode, seconds })) },
  evidenceReuse: '培训视觉、分页和原资源卡证据已失效，由本轮替代。总览组件与配色字节未变化，共用模型的泛型分页由本轮测试覆盖。其它会议业务与原清单匹配；周会/后端/Python只在源、工具、配置指纹相同条件下复用。共享入口合并和正式运行闭包由发布入口复核。',
  cleanup: { browserClosed: true, syntheticDataOnlyInClosedBrowser: true, externalWrites: false, previewIntentionallyRunning: [4200, 4201] },
  release: { ownerThread: '01a05194-1697-7c73-a9ca-ce80b8cff3bc', formalBuild: false, package: false, deployed: false, oldSchedulerStillRunning: true, newSchedulerEnabled: false, templateLatestConfirmed: false },
};
fs.writeFileSync(path.join(root, out, 'freeze-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ sourceFiles: manifest.sourceInputs.length, delta: businessDrift, added: added.length, sharedDrift: manifest.sharedDriftSincePredecessor, p95Ms: browser.filterP95Ms, manifest: fingerprint(`${out}/freeze-manifest.json`) }));
