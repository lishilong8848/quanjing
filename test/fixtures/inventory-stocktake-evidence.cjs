const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
function fingerprintSources(entries) {
  const queue = entries.map((file) => path.resolve(root, file));
  const seen = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      const id = match[1];
      const base = id.startsWith('.')
        ? path.resolve(path.dirname(file), id)
        : id.startsWith('@server/')
          ? path.join(root, 'server', id.slice(8))
          : id.startsWith('@shared/')
            ? path.join(root, 'shared', id.slice(8))
            : id.startsWith('@/')
              ? path.join(root, 'client/src', id.slice(2))
              : null;
      if (!base) continue;
      const next = [
        base,
        ...[
          '.ts',
          '.tsx',
          '.js',
          '.cjs',
          '.json',
          '/index.ts',
          '/index.tsx',
        ].map((ext) => base + ext),
      ].find(
        (candidate) =>
          fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      );
      if (next && next.startsWith(root + path.sep)) queue.push(next);
    }
  }
  for (const file of [
    'package.json',
    'package-lock.json',
    'tsconfig.node.json',
    'tsconfig.app.json',
  ])
    seen.add(path.join(root, file));
  return {
    node: process.version,
    files: [...seen].sort().map((file) => ({
      path: path.relative(root, file).replace(/\\/g, '/'),
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex'),
    })),
  };
}
module.exports = { fingerprintSources };
