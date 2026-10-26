const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const postcss = require('postcss');
const [sourceArg, clientArg, reportArg] = process.argv.slice(2);
if (!sourceArg || !clientArg || !reportArg) throw new Error('Require source root, client root and report');
const root = path.resolve(sourceArg), client = path.resolve(clientArg);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = s => s.replace(/\s+/g, '').replace(/["']/g, '').replace(/\*?::?(before|after|first-line|first-letter)\b/g, ':$1');
const list = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const modules = new Map(), styles = new Map();
function resolve(name, parent) {
  const base = name.startsWith('@/') ? path.join(root, 'client/src', name.slice(2)) : name.startsWith('@shared/') ? path.join(root, 'shared', name.slice(8)) : name.startsWith('.') ? path.resolve(path.dirname(parent), name) : null;
  if (!base) return null;
  return [base, ...['.ts', '.tsx', '.js', '.jsx', '.css', '.json'].map(ext => base + ext), ...['index.ts', 'index.tsx', 'index.js'].map(f => path.join(base, f))].find(f => fs.existsSync(f) && fs.statSync(f).isFile()) || null;
}
function visit(file) {
  if (modules.has(file)) return;
  const bytes = fs.readFileSync(file), content = bytes.toString('utf8');
  modules.set(file, sha(bytes));
  if (file.endsWith('.css')) {
    const ast = postcss.parse(content);
    styles.set(file, ast);
    ast.walkAtRules('import', r => { const match = r.params.match(/^(?:url\()?['"]([^'"]+)['"]/); if (match) { const next = resolve(match[1], file); if (next) visit(next); } });
  } else if (/\.[cm]?[jt]sx?$/.test(file)) {
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const walk = node => {
      let name;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) name = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) name = node.arguments[0].text;
      if (name) { const next = resolve(name, file); if (next) visit(next); }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  }
}
visit(path.join(root, 'client/src/index.tsx'));
const artifacts = [], emittedRules = new Map(), variables = new Set();
for (const file of list(client).filter(f => f.endsWith('.css') && !f.endsWith('.legacy.css') && !f.includes(path.sep + 'meeting-templates' + path.sep) && !f.includes(path.sep + 'overtime-confirmation' + path.sep))) {
  const bytes = fs.readFileSync(file);
  artifacts.push({ path: path.relative(client, file).replaceAll('\\', '/'), sha256: sha(bytes) });
  const ast = postcss.parse(bytes.toString('utf8'));
  ast.walkDecls(d => { if (d.prop.startsWith('--')) variables.add(d.prop); });
  ast.walkRules(r => { const key = normalize(r.selector), props = emittedRules.get(key) || new Set(); r.walkDecls(d => props.add(d.prop)); emittedRules.set(key, props); });
}
const checks = [];
for (const [file, ast] of styles) {
  const definitions = new Set();
  ast.walkDecls(d => { if (d.prop.startsWith('--')) definitions.add(d.prop); });
  const first = ast.nodes.find(n => n.type === 'rule');
  const firstProps = first ? first.nodes.filter(n => n.type === 'decl').map(n => n.prop) : [];
  const emitted = first ? emittedRules.get(normalize(first.selector)) : undefined;
  checks.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: modules.get(file), firstSelector: first?.selector || null, missingFirstProperties: firstProps.filter(p => !emitted?.has(p)), definitionCount: definitions.size, missingVariables: [...definitions].filter(p => !variables.has(p)) });
}
const proof = { generatedAt: new Date().toISOString(), toolSha256: sha(fs.readFileSync(__filename)), sourceRoot: root, clientRoot: client, modules: [...modules].map(([file, hash]) => ({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: hash })), artifacts, checks, passed: checks.length > 0 && checks.every(c => !c.missingFirstProperties.length && !c.missingVariables.length), scope: 'Literal local import graph from the actual app entry, source CSS variables and first-rule properties against the built main client. No source maps or live server assumptions; not a business-signoff substitute.' };
fs.writeFileSync(path.resolve(reportArg), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ passed: proof.passed, modules: modules.size, stylesheets: checks.length, artifacts: artifacts.length, failures: checks.filter(c => c.missingFirstProperties.length || c.missingVariables.length) }));
if (!proof.passed) process.exitCode = 1;
