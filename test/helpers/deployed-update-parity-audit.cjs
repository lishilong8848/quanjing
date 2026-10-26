const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const postcss = require('postcss');
const root = path.resolve(__dirname, '../..');
const sourceRoot = path.join(root, 'output/production-registration-20261010-100240/source');
const clientRoot = 'D:/ai/nt-smoke-pool/candidate-20261010-100240/dist/client';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'output/release-next-after-20261007-202518/release-input.json')));
const publication = JSON.parse(fs.readFileSync(path.join(root, 'output/production-registration-20261010-100240/prepared-source.json')));
const archived = new Map(manifest.files.map((f) => [f.path, f]));
const sourceChecks = publication.changed.map((name) => {
  const input = archived.get(name);
  return { path: name, archived: Boolean(input), archiveMatches: Boolean(input) && sha(fs.readFileSync(path.join(sourceRoot, name))) === input.sha256,
    workspaceMatches: Boolean(input) && sha(fs.readFileSync(path.join(root, name))) === input.sha256 };
});
const declarations = new Set();
for (const file of files(clientRoot).filter((f) => f.endsWith('.css') && !f.endsWith('.legacy.css'))) {
  postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((d) => { if (d.prop.startsWith('--')) declarations.add(d.prop); });
}
const cssChecks = [];
for (const file of files(path.join(sourceRoot, 'client/src')).filter((f) => f.endsWith('.css'))) {
  const props = new Set();
  const selectors = new Set();
  postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((d) => {
    if (d.prop.startsWith('--')) { props.add(d.prop); if (d.parent.selector) selectors.add(d.parent.selector); }
  });
  if (props.size) cssChecks.push({ path: path.relative(sourceRoot, file).replaceAll('\\', '/'), definitions: props.size,
    missingInDeployedCss: [...props].filter((p) => !declarations.has(p)), definitionSelectors: [...selectors] });
}
const groups = {};
for (const item of sourceChecks) {
  const parts = item.path.split('/');
  const group = parts[0] === 'client' && parts[2] === 'pages' ? parts.slice(0, 4).join('/')
    : parts[0] === 'server' && parts[1] === 'modules' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
  (groups[group] ??= []).push(item.path);
}
const proof = { generatedAt: new Date().toISOString(), deploymentId: 'nantong-safe-full-runtime-hotfix-20261010-100240',
  toolSha256: sha(fs.readFileSync(__filename)), scope: 'Every declared two-day changed archive input and all client custom-property definitions; static coverage, not functional signoff',
  changedCount: sourceChecks.length, sourceChecks, groups, cssChecks,
  sourceCoveragePassed: sourceChecks.every((f) => f.archived && f.archiveMatches && f.workspaceMatches),
  missingCssFiles: cssChecks.filter((f) => f.missingInDeployedCss.length).length,
  functionalSignoff: false };
fs.writeFileSync(path.join(root, 'output/production-css-diagnosis-20261010/all-updates-static-audit.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ sourceCoveragePassed: proof.sourceCoveragePassed, changedCount: proof.changedCount,
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  cssMissing: cssChecks.filter((f) => f.missingInDeployedCss.length).map((f) => ({ path: f.path, missing: f.missingInDeployedCss.length })) }));
