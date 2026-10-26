const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const postcss = require('postcss');

const root = path.resolve(__dirname, '../..');
const [clientArg, mapArg, reportArg] = process.argv.slice(2);
if (!clientArg || !mapArg || !reportArg) throw new Error('Require client root, CSS map root and report path');
const client = path.resolve(clientArg);
const maps = path.resolve(mapArg);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const list = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const selector = s => s.replace(/\s+/g, '').replace(/["']/g, '').replace(/\*?::?(before|after|first-line|first-letter)\b/g, ':$1');
const proof = { generatedAt: new Date().toISOString(), toolSha256: sha(fs.readFileSync(__filename)), client, maps, files: [], passed: false, limitations: ['CSS source-map declaration preservation is a static artifact check, not business or browser signoff.'] };
for (const file of list(client).filter(f => f.endsWith('.css') && !f.includes(path.sep + 'meeting-templates' + path.sep) && !f.includes(path.sep + 'overtime-confirmation' + path.sep))) {
  const bytes = fs.readFileSync(file);
  const css = bytes.toString('utf8');
  const mapPath = path.join(maps, path.basename(file).replace('.legacy.css', '.css') + '.map');
  const item = { file: path.relative(client, file).replaceAll('\\', '/'), sha256: sha(bytes), mapSha256: null, sources: [], failures: [] };
  if (/window\.__RELEASE_COMMIT_ID__\s*=/.test(css)) item.failures.push('javascript-release-banner-in-css');
  if (!fs.existsSync(mapPath)) item.failures.push('missing-source-map');
  else {
    const mapBytes = fs.readFileSync(mapPath);
    item.mapSha256 = sha(mapBytes);
    const map = JSON.parse(mapBytes);
    const emitted = postcss.parse(css);
    const declarations = new Set();
    const rules = new Map();
    emitted.walkDecls(d => declarations.add(d.prop));
    emitted.walkRules(r => {
      const key = selector(r.selector);
      const props = rules.get(key) || new Set();
      r.walkDecls(d => props.add(d.prop));
      rules.set(key, props);
    });
    for (let i = 0; i < map.sources.length; i++) {
      const source = map.sources[i];
      if (!source.includes('/client/src/') || !source.endsWith('.css')) continue;
      const content = map.sourcesContent?.[i];
      if (typeof content !== 'string') { item.failures.push('missing-source-content:' + source); continue; }
      const parsed = postcss.parse(content);
      const expected = new Set();
      parsed.walkDecls(d => { if (d.prop.startsWith('--')) expected.add(d.prop); });
      const missingVariables = [...expected].filter(p => !declarations.has(p));
      const firstRule = parsed.nodes.find(n => n.type === 'rule');
      const firstProps = firstRule ? firstRule.nodes.filter(n => n.type === 'decl').map(d => d.prop) : [];
      const actualProps = firstRule ? rules.get(selector(firstRule.selector)) : undefined;
      const missingFirstRuleProperties = firstProps.filter(p => !actualProps?.has(p));
      item.sources.push({ source, contentSha256: sha(content), expectedVariableCount: expected.size, missingVariables, firstSelector: firstRule?.selector || null, missingFirstRuleProperties });
      if (missingVariables.length || missingFirstRuleProperties.length) item.failures.push('lost-source-declarations:' + source);
    }
  }
  proof.files.push(item);
}
proof.passed = proof.files.length > 0 && proof.files.every(f => f.failures.length === 0);
fs.writeFileSync(path.resolve(reportArg), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ passed: proof.passed, stylesheets: proof.files.length, sources: proof.files.reduce((n, f) => n + f.sources.length, 0), failures: proof.files.filter(f => f.failures.length).map(f => ({ file: f.file, failures: f.failures, sources: f.sources.filter(s => s.missingVariables.length || s.missingFirstRuleProperties.length) })) }));
if (!proof.passed) process.exitCode = 1;
