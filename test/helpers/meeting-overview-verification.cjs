const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = 'output/meeting-overview-validation';
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const overview = read(`${output}/browser-proof.json`);
const archive = read('output/meeting-management-validation/browser-proof.json');
const performance = read(`${output}/performance-proof.json`);
if (!overview.passed || !archive.passed || performance.mode !== 'production' ||
    performance.filterP95 > 100 || performance.demoDialogP95 > 150 || performance.weeklyDialogP95 > 150) {
  throw new Error('当前浏览器或性能证据未通过，不得写源码冻结清单');
}
const directories = ['server/modules/meeting-management', 'client/src/pages/MeetingManagement'];
const inputs = [
  ...directories.flatMap(dir => fs.readdirSync(path.join(root, dir)).map(name => `${dir}/${name}`)),
  'shared/meeting-management.interface.ts', 'server/app.module.ts',
  'client/src/app.tsx', 'client/src/components/Layout.tsx', 'client/src/navigation/page-switcher.ts',
  'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
  'client/src/access/AccessProvider.tsx', 'client/src/components/GlobalNavigation.tsx',
  'client/src/components/ui/dialog.tsx', 'server/common/feishu/bitable-direct-read.ts',
  'shared/access-control.interface.ts', 'test/unit/page-switcher.spec.ts',
  'test/unit/meeting-management-model.spec.ts', 'test/unit/meeting-overview.spec.ts',
  'test/jest.meeting-management.config.cjs', 'test/helpers/meeting-browser-entry.tsx',
  'test/helpers/meeting-browser-fixture.cjs', 'test/helpers/meeting-browser.rspack.cjs',
  'test/helpers/meeting-browser.css', 'test/helpers/meeting-overview-verification.cjs',
  'test/visual/meeting-management-browser.cjs', 'test/visual/meeting-overview-browser.cjs',
  'test/visual/meeting-performance.cjs', 'test/visual/meeting-overview-performance.cjs',
  'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'docs/engineering/release-handoff-2026-10-08-meeting-overview.md',
  'docs/superpowers/specs/2026-10-08-meeting-overview-design.md',
];
const fingerprint = relative => ({ path: relative,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex') });
const evidence = {
  generatedAt: new Date().toISOString(), state: 'source-frozen', node: process.version,
  inputs: inputs.map(fingerprint),
  proofs: [`${output}/browser-proof.json`, `${output}/performance-proof.json`,
    'output/meeting-management-validation/browser-proof.json',
    'output/meeting-management-validation/source-read.json'].map(fingerprint),
  observedCommands: {
    jest: { suites: 7, tests: 40, seconds: 12.16, exitCode: 0,
      record: '本会话已执行定向7套测试的工具输出观察记录；未为生成文件重复执行' },
    clientTypes: { command: 'node node_modules/typescript/bin/tsc --noEmit --project tsconfig.app.json', exitCode: 0, session: 35055 },
    serverTypes: { command: 'node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json', exitCode: 0, session: 12969 },
    eslint: { exitCode: 0, session: 82288, excludedRule: '@darraghor/nestjs-typed/injectable-should-be-provided', actualNestDI: 'passed' },
    stylelint: { exitCode: 0, session: 54173 },
    previewBuild: { mode: 'production', seconds: 2.83, exitCode: 0, formalApplicationBuild: false },
  },
  results: { overviewChecks: overview.checks.length, archiveChecks: archive.checks.length,
    filterP95: performance.filterP95, demoCachedDialogP95: performance.demoDialogP95,
    weeklyCachedDialogP95: performance.weeklyDialogP95, initialDemoDialogMs: performance.initialDemoDialogMs },
  validity: '会议业务源、相关共享入口、适配器、工具/配置/依赖输入不变；相关变化时复核对应哈希与证据。这不是完整发布闭包或服务器指纹证明。',
  preview: { active: true, frontend: 'http://127.0.0.1:4200/meeting-management', backendPort: 4201,
    externalWrites: false, fixtureRole: 'admin', fixtureMode: 'normal' },
  release: { ownerThread: '01a05194-1697-7c73-a9ca-ce80b8cff3bc', formalBuild: false, package: false, deployed: false },
};
fs.writeFileSync(path.join(root, output, 'verification-manifest.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ state: evidence.state, inputs: inputs.length, results: evidence.results }));
