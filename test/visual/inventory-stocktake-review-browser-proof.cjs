const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/inventory-stocktake-review-check');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (process.argv[2] === 'begin') {
  const inputs = require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources([
    'test/fixtures/inventory-stocktake-browser/entry.tsx', 'test/fixtures/inventory-stocktake-browser/api.ts', 'test/fixtures/inventory-stocktake-browser/performance.ts',
    'test/visual/inventory-stocktake-dev-server.cjs', 'test/visual/inventory-stocktake-review-browser-proof.cjs', 'client/src/pages/InventoryManagement/inventory-stocktake.css',
  ]);
  fs.writeFileSync(path.join(output, 'browser-inputs.json'), JSON.stringify(inputs, null, 2));
  console.log(JSON.stringify({ inputs: inputs.files.length }));
} else if (process.argv[2] === 'finish') {
  const inputs = JSON.parse(fs.readFileSync(path.join(output, 'browser-inputs.json')));
  const drift = inputs.files.filter(file => hash(path.join(root, file.path)) !== file.sha256);
  const result = { checkedAt: new Date().toISOString(), stable: !drift.length, drift, inputs,
    result: JSON.parse(fs.readFileSync(path.join(output, 'browser-actions.json'))),
    screenshots: ['desktop.png', 'mobile.png', 'results.png'].map(file => ({ file, sha256: hash(path.join(output, file)) })) };
  fs.writeFileSync(path.join(output, 'browser-final.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ stable: result.stable, drift: drift.map(file => file.path), screenshotCount: result.screenshots.length }));
  if (drift.length || !result.result.passed) process.exitCode = 1;
} else throw new Error('Specify begin or finish');
