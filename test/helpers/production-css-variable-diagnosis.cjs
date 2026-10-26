const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const postcss = require('postcss');
const { rspack, LightningCssMinimizerRspackPlugin } = require('@rspack/core');

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/production-css-diagnosis-20261010');
const files = [
  'client/src/pages/ThresholdManagement/styles.css',
  'client/src/pages/MeetingManagement/styles.css',
  'client/src/pages/MeetingManagement/weekly-workbench.css',
];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const declarations = (css) => {
  const found = new Map();
  postcss.parse(css).walkDecls((d) => {
    if (d.prop.startsWith('--')) found.set(d.prop, d.value);
  });
  return found;
};
async function compile(name, options) {
  const target = path.join(out, name);
  const preset = options.preset ? require('@lark-apaas/fullstack-rspack-preset').createFullstackRspackConfig() : {};
  const compiler = rspack({
    mode: 'production', context: root, devtool: options.maps ? 'hidden-source-map' : false,
    entry: options.dynamic ? path.join(__dirname, 'production-css-variable-dynamic-entry.js') : options.jsEntry ? path.join(__dirname, 'production-css-variable-entry.js') : files.map((f) => path.join(root, f)),
    experiments: { css: true },
    module: options.preset ? preset.module : { rules: [{ test: /\.css$/, type: 'css', ...options.rule }] },
    optimization: { minimize: false, ...(options.preset ? preset.optimization : {}), ...options.optimization },
    plugins: options.preset ? preset.plugins.filter((p) => p && p.constructor.name === 'CssLegacyPlugin') : [],
    output: { path: target, filename: 'probe.js', cssFilename: 'probe.css' },
  });
  const start = performance.now();
  const stats = await new Promise((resolve, reject) => compiler.run((e, s) => e ? reject(e) : resolve(s)));
  await new Promise((resolve, reject) => compiler.close((e) => e ? reject(e) : resolve()));
  if (stats.hasErrors()) throw Error(stats.toString({ all: false, errors: true }));
  const css = fs.readdirSync(target).filter((f) => f.endsWith('.css') && !f.endsWith('.legacy.css')).map((f) => fs.readFileSync(path.join(target, f), 'utf8')).join('\n');
  const props = declarations(css);
  return { name, milliseconds: performance.now() - start, cssSha256: sha(css),
    declarations: Object.fromEntries(props), missing: [...expected.keys()].filter((p) => !props.has(p)) };
}
const expected = new Map(files.flatMap((f) => [...declarations(fs.readFileSync(path.join(root, f), 'utf8'))]));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const proof = { node: process.version, toolSha256: sha(fs.readFileSync(__filename)),
    inputs: files.map((f) => ({ path: f, sha256: sha(fs.readFileSync(path.join(root, f))) })),
    expected: Object.fromEntries(expected), postcss: [], builds: [] };
  for (const f of files) {
    const input = fs.readFileSync(path.join(root, f), 'utf8');
    const result = await postcss([require('postcss-import')(), require('@tailwindcss/postcss')(), require('autoprefixer')()])
      .process(input, { from: path.join(root, f) });
    const props = declarations(result.css);
    proof.postcss.push({ path: f, missing: [...declarations(input).keys()].filter((p) => !props.has(p)) });
  }
  const postcssRule = { use: [{ loader: 'postcss-loader', options: { postcssOptions: {
    plugins: [['postcss-import', {}]],
  } } }] };
  for (const [name, options] of [
    ['builtin-only', {}],
    ['builtin-minimized', { optimization: { minimize: true, minimizer: [new LightningCssMinimizerRspackPlugin()] } }],
    ['actual-postcss', { rule: postcssRule }],
    ['actual-postcss-minimized', { rule: postcssRule, optimization: { minimize: true, minimizer: [new LightningCssMinimizerRspackPlugin()] } }],
    ['exports-disabled', { optimization: { usedExports: false } }],
    ['js-import', { jsEntry: true, rule: postcssRule }],
    ['js-import-exports-disabled', { jsEntry: true, rule: postcssRule, optimization: { usedExports: false } }],
    ['js-import-exports-enabled', { jsEntry: true, rule: postcssRule, optimization: { usedExports: true } }],
    ['js-import-exports-enabled-minimized', { jsEntry: true, rule: postcssRule, optimization: { usedExports: true, minimize: true, minimizer: [new LightningCssMinimizerRspackPlugin()] } }],
    ['actual-preset', { jsEntry: true, preset: true }],
    ['actual-preset-dynamic', { dynamic: true, preset: true }],
    ['actual-preset-dynamic-sourcemaps', { dynamic: true, preset: true, maps: true }],
  ]) {
    proof.builds.push(await compile(name, options));
    console.log(JSON.stringify(proof.builds.at(-1)));
  }
  fs.writeFileSync(path.join(out, 'diagnosis.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ postcss: proof.postcss }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
