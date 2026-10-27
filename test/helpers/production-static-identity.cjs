const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = 'D:/ai/nt-smoke-pool/candidate-20261010-100240/dist/client';
const files = ['index.html', 'main.css', 'main.js', 'chunks/4915.ca982bf0.css',
  'chunks/9031.51a461df.css', 'chunks/1339.41e4f893.css'];
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
(async () => {
  const results = [];
  for (const name of files) {
    const local = fs.readFileSync(path.join(root, name));
    try {
      const response = await fetch('http://sm.sjhl.online:3001/' + name, {
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const remote = Buffer.from(await response.arrayBuffer());
      results.push({ name, status: response.status, contentType: response.headers.get('content-type'),
        bytes: remote.length, localSha256: sha(local), remoteSha256: sha(remote), same: local.equals(remote) });
    } catch (e) { results.push({ name, errorName: e.name, causeCode: e.cause?.code || null }); }
  }
  const out = path.resolve('output/production-css-diagnosis-20261010/live-static-identity.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), publicGetOnly: true, results }, null, 2));
  console.log(JSON.stringify(results));
})().catch((e) => { console.error(e.name); process.exitCode = 1; });
