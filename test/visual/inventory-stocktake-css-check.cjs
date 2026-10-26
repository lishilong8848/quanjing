// Tiny CSS-only compiler experiment; never builds the application or a release.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rspack, LightningCssMinimizerRspackPlugin } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-stocktake-css-'));
const original =
  '.probe{--gap:.75rem;padding:1.25rem 2rem}.child{gap:var(--gap)}';
const results = [];
async function check(type, optimize) {
  const css = path.join(temp, 'input.css');
  fs.writeFileSync(css, original);
  const compiler = rspack({
    context: temp,
    mode: 'development',
    devtool: false,
    entry: css,
    output: {
      path: path.join(temp, type.replace('/', '-') + optimize),
      filename: 'entry.js',
    },
    module: { rules: [{ test: /\.css$/, type }] },
    experiments: { css: true },
    optimization: optimize
      ? {
          minimize: true,
          usedExports: true,
          sideEffects: true,
          minimizer: [new LightningCssMinimizerRspackPlugin()],
        }
      : { minimize: false },
  });
  try {
    const stats = await new Promise((resolve, reject) =>
      compiler.run((err, stats) =>
        err
          ? reject(err)
          : stats.hasErrors()
            ? reject(new Error(stats.toString({ all: false, errors: true })))
            : resolve(stats),
      ),
    );
    const assets = stats.compilation
      .getAssets()
      .filter((a) => a.name.endsWith('.css'));
    const output = assets.map((a) => a.source.source().toString()).join('\n');
    results.push({
      type,
      optimize,
      firstRuleRetained: output.includes('--gap:'),
      output,
    });
  } finally {
    await new Promise((resolve) => compiler.close(resolve));
  }
}
(async () => {
  try {
    for (const type of ['css', 'css/auto'])
      for (const optimize of [false, true]) await check(type, optimize);
    const output = path.join(
      root,
      'output/inventory-stocktake-r2-check/css-diagnostic.json',
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ original, results }, null, 2));
    console.log(JSON.stringify(results));
  } finally {
    if (
      path.dirname(fs.realpathSync(temp)) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(temp).startsWith('nt-stocktake-css-')
    )
      throw new Error('Unsafe CSS fixture cleanup');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
