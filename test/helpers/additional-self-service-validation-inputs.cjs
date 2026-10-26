const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/additional-self-service-autofill-20261011');
const own = [
  'server/common/access/self-service-applicant.ts',
  'server/modules/purchase-inventory/purchase-application.service.ts',
  'server/modules/purchase-inventory/purchase-inventory.controller.ts',
  'shared/purchase-application.interface.ts', 'client/src/api/index.ts',
  'client/src/pages/PurchaseInventoryManagement/PurchaseApplicationDialog.tsx',
  'server/modules/duty-schedule/duty-schedule.controller.ts',
  'server/modules/duty-schedule/duty-schedule.service.ts',
  'client/src/pages/MonthlySchedule/ChangeSummaryReportDialog.tsx',
  'server/modules/system-monthly-report/system-monthly-report.gateway.ts',
  'server/modules/system-monthly-report/system-monthly-report-identity.service.ts',
  'server/modules/system-monthly-report/system-monthly-report.controller.ts',
  'client/src/pages/SystemMonthlyReport/api.ts',
  'client/src/pages/SystemMonthlyReport/index.tsx',
];
const files = new Set();
const pending = [...own,
  'test/helpers/additional-self-service-browser-entry.tsx',
  'test/helpers/additional-self-service-browser-fixture.cjs',
  'test/helpers/additional-self-service-browser.rspack.cjs',
  'test/helpers/additional-self-service-validation-inputs.cjs',
  'test/jest.additional-self-service.config.cjs',
  'test/unit/additional-self-service-identity.spec.ts',
  'test/unit/purchase-access-controller.spec.ts',
  'test/unit/monthly-schedule-change-summary-report.spec.ts',
];
function resolveLocal(specifier, importer) {
  const bases = specifier.startsWith('.') ? [path.resolve(path.dirname(importer), specifier)]
    : specifier.startsWith('@shared/') ? [path.join(root, 'shared', specifier.slice(8))]
      : specifier.startsWith('@server/') ? [path.join(root, 'server', specifier.slice(8))]
        : specifier.startsWith('@/') ? [path.join(root, 'client/src', specifier.slice(2))] : [];
  for (const base of bases) for (const suffix of ['', '.ts', '.tsx', '.json', '.js', '.cjs', '/index.ts', '/index.tsx']) {
    const file = base + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
}
while (pending.length) {
  const file = path.resolve(root, pending.pop());
  if (files.has(file)) continue;
  files.add(file);
  if (!/\.(?:[jt]sx?|cjs)$/.test(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const dependency = resolveLocal(match[1], file);
    if (dependency) pending.push(dependency);
  }
}
for (const file of ['package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json', 'client/src/index.css']) files.add(path.join(root, file));
const entries = [...files].sort().map(file => ({ path: path.relative(root, file).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const name = process.argv[2] || 'validation-inputs';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, own, fingerprint, files: entries }, null, 2));
console.log(JSON.stringify({ name, sourceFiles: entries.length, fingerprint }));
