const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { rspack, BannerPlugin, LightningCssMinimizerRspackPlugin } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/production-css-diagnosis-20261010/banner');
async function build(name, test, plugins) {
  const compiler = rspack({ mode: 'production', context: root,
    entry: path.join(root, 'client/src/pages/ThresholdManagement/styles.css'),
    experiments: { css: true }, module: { rules: [{ test: /\.css$/, type: 'css' }] },
    optimization: { minimize: true, minimizer: [new LightningCssMinimizerRspackPlugin()] },
    plugins: plugins || [new BannerPlugin({ banner: "window.__RELEASE_COMMIT_ID__ = 'diagnostic';", raw: true, ...(test ? { test } : {}) })],
    output: { path: path.join(out, name), filename: 'probe.js', cssFilename: 'probe.css' },
  });
  const stats = await new Promise((resolve, reject) => compiler.run((e, s) => e ? reject(e) : resolve(s)));
  await new Promise((resolve, reject) => compiler.close(e => e ? reject(e) : resolve()));
  assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
  const css = fs.readFileSync(path.join(out, name, 'probe.css'), 'utf8');
  return { name, firstRuleRetained: /--tm-bg\s*:/.test(css), firstBytes: css.slice(0, 120),
    javascriptMarkerRetained: fs.readFileSync(path.join(out, name, 'probe.js'), 'utf8').includes('__RELEASE_COMMIT_ID__') };
}
(async () => {
  const broken = await build('original');
  const restricted = await build('javascript-only', /\.[cm]?js$/i);
  const config = require(path.join(root, 'rspack.config.js'));
  const base = config.plugins || require('@lark-apaas/fullstack-rspack-preset/preset.config.js').plugins;
  const actual = await build('actual-project-config', null, base.filter(p => p instanceof BannerPlugin));
  fs.writeFileSync(path.join(out, 'project-result.json'), JSON.stringify({ broken, restricted, actual }, null, 2));
  console.log(JSON.stringify({ broken, restricted, actual }));
  assert.equal(actual.firstRuleRetained, true, 'Project production banner must preserve first CSS variable rule');
  assert.equal(actual.javascriptMarkerRetained, true, 'JavaScript release marker must remain');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
