const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/self-service-autofill-20261011');
const own = JSON.parse(fs.readFileSync(path.join(output, 'typecheck-input.json'), 'utf8')).files.map(item => item.path);
const files = new Set();
const pending = [...own, 'test/helpers/self-service-browser-entry.tsx'];
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
for (const file of [
  'package.json', 'package-lock.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'test/jest.self-service.config.cjs', 'test/jest.feishu-login.config.cjs',
  'test/helpers/self-service-browser-fixture.cjs', 'test/helpers/self-service-browser.rspack.cjs', 'test/helpers/meeting-browser.rspack.cjs',
  'test/helpers/self-service-validation-inputs.cjs',
  ...fs.readdirSync(path.join(root, 'test/unit')).filter(name => /^(self-service-identity|mbti-self-identity|mbti-entry-ui|site-member-overtime|leave-request-applicant|monthly-schedule-(?:overtime-request|change-request|leave-request|access-ui|form-deep-link)|change-request-(?:direct-entry|people-service)|duty-schedule-(?:controller-routes|service-views))\.spec\.ts$/.test(name)).map(name => 'test/unit/' + name),
  'server/modules/bitable-sync/mbti-assessment.service.spec.ts',
]) files.add(path.join(root, file));
const entries = [...files].sort().map(file => ({ path: path.relative(root, file).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const capture = { capturedAt: new Date().toISOString(), node: process.version, own, fingerprint, files: entries };
const name = process.argv[2] || 'validation-inputs';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name');
fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(capture, null, 2));
console.log(JSON.stringify({ name, sourceFiles: entries.length, fingerprint }));
