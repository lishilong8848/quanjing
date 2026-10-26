const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'output/production-registration-20261010-100240/source');
const out = path.join(root, 'output/production-css-diagnosis-20261010/full');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const inspect = (name, value) => {
  const css = String(value);
  return { name, bytes: Buffer.byteLength(css), sha256: sha(css),
    tmDefinition: /--tm-bg\s*:/.test(css), meetingDefinition: /--meeting-gap\s*:/.test(css),
    tmReference: /var\(--tm-bg/.test(css), meetingReference: /var\(--meeting-gap/.test(css) };
};
class CssTracePlugin {
  apply(compiler) {
    const proof = { startedAt: new Date().toISOString(), modules: [], assets: [] };
    compiler.hooks.thisCompilation.tap('CssTrace', (compilation) => {
      compilation.hooks.succeedModule.tap('CssTrace', (module) => {
        if (module.resource && /(?:MeetingManagement|ThresholdManagement)[\\/].*\.css$/.test(module.resource)) {
          const original = module.originalSource();
          proof.modules.push(inspect(module.resource, original ? original.source() : ''));
        }
      });
      for (const stage of [-100, 399, 401, 2500]) {
        compilation.hooks.processAssets.tap({ name: 'CssTrace' + stage, stage }, (assets) => {
          for (const [name, asset] of Object.entries(assets)) {
            if (name.endsWith('.css') && !name.endsWith('.legacy.css')) proof.assets.push({ stage, ...inspect(name, asset.source()) });
          }
        });
      }
    });
    compiler.hooks.done.tap('CssTrace', (stats) => {
      proof.finishedAt = new Date().toISOString();
      proof.failed = stats.hasErrors();
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'trace.json'), JSON.stringify(proof, null, 2));
    });
  }
}
module.exports = {
  extends: path.join(source, 'rspack.config.js'),
  context: source,
  output: { path: path.join(out, 'client'), clean: false },
  plugins: [new CssTracePlugin()],
};
