const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const out = 'output/meeting-overview-refresh-20261009';
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const fingerprint = file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') });
const priorPath = 'output/meeting-sources-validation/freeze-manifest.json';
const prior = read(priorPath);
const browser = read(`${out}/browser-proof.json`);
const jest = read(`${out}/jest-results.json`);
if (!browser.passed || !jest.success) throw new Error('验收未通过，不能冻结');
const changedBusiness = ['client/src/pages/MeetingManagement/MeetingOverview.tsx', 'client/src/pages/MeetingManagement/model.ts', 'client/src/pages/MeetingManagement/styles.css'];
const drift = group => prior[group].filter(item => fingerprint(item.path).sha256 !== item.sha256).map(item => item.path);
const businessDrift = drift('sourceInputs');
if (businessDrift.some(file => !changedBusiness.includes(file))) throw new Error(`存在未验收业务变化：${businessDrift.join(', ')}`);
const tools = ['test/unit/meeting-management-model.spec.ts', 'test/visual/meeting-overview-refresh.cjs', 'test/helpers/meeting-overview-refresh-freeze.cjs', 'test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser.rspack.cjs', 'test/helpers/meeting-browser-entry.tsx', 'test/helpers/meeting-browser-fixture.cjs'];
const manifest = {
  state: 'source-frozen', generatedAt: new Date().toISOString(), node: process.version,
  predecessor: fingerprint(priorPath), changedBusiness: changedBusiness.map(fingerprint),
  sourceInputs: prior.sourceInputs.map(item => fingerprint(item.path)),
  sharedInputs: prior.sharedInputs.map(item => fingerprint(item.path)),
  sharedDriftSincePredecessor: drift('sharedInputs'), verificationTools: tools.map(fingerprint),
  documentation: fingerprint('docs/engineering/release-handoff-2026-10-09-meeting-overview-refresh.md'),
  proofs: ['browser-proof.json', 'jest-results.json', 'client.tsbuildinfo', 'desktop.png', 'mobile.png'].map(file => fingerprint(`${out}/${file}`)),
  results: { jestTests: jest.numPassedTests, browserChecks: browser.checks.length, browserErrors: browser.errors, metrics: browser.metrics, palette: browser.palette, clientTypes: 'exit0', eslint: 'exit0; unit file ignored by existing configuration', stylelint: 'exit0', isolatedCompileSeconds: 3.61 },
  evidenceReuse: '旧总览配色与指标证据失效，由本次浏览器和模型单测替代。后端、周会表单、生成引擎与资源列表业务字节未变化；其既有证据仅在对应闭包、工具和配置指纹仍相同时复用。共享入口变化由发布负责人复核。',
  release: { ownerThread: '01a05194-1697-7c73-a9ca-ce80b8cff3bc', formalBuild: false, package: false, deployed: false },
  cleanup: { browserClosed: true, externalWrites: false, previewIntentionallyRunning: [4200, 4201] },
};
fs.writeFileSync(path.join(root, out, 'freeze-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ changedBusiness: businessDrift, sharedDrift: manifest.sharedDriftSincePredecessor, manifest: fingerprint(`${out}/freeze-manifest.json`) }));
