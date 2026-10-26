const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const config = require(path.join(root, 'rspack.config.js'));
const out = path.join(root, 'output/production-parity-validation-20261010');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
class SaveParityBuildProof {
  apply(compiler) {
    const startedAt = new Date().toISOString();
    compiler.hooks.done.tap('SaveParityBuildProof', stats => {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'build-proof.json'), JSON.stringify({
        startedAt, finishedAt: new Date().toISOString(), node: process.version,
        configurationSha256: sha(fs.readFileSync(path.join(root, 'rspack.config.js'))),
        errors: stats.toJson({ all: false, errors: true }).errors,
        limitations: ['Only public-file copying is excluded to avoid changing shared dist; these files are served from the source public directory in validation.', 'Diagnostic production build, not a formal candidate.'],
      }, null, 2));
    });
  }
}
module.exports = {
  ...config,
  context: root,
  output: { ...config.output, path: path.join(out, 'client'), clean: false },
  plugins: [...config.plugins.filter(p => p.constructor.name !== 'CopyRspackPlugin'), new SaveParityBuildProof()],
};
