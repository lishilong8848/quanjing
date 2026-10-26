'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const nodes = [], listeners = {};
const sandbox = { exports: {}, document: {
  createElement: () => { const node = { style: {}, dataset: {}, addEventListener() {} }; nodes.push(node); return node; },
  body: { append() {} }, addEventListener: (name, callback) => { (listeners[name] ||= []).push(callback); }
}, performance: { now: () => 0 }, PerformanceObserver: class { static supportedEntryTypes = []; observe() {} },
  window: { fetch() {} }, XMLHttpRequest: class { open() {} } };
const probeSource = fs.readFileSync(path.join(root, 'test/fixtures/admin-configuration-browser/performance.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(probeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const probe = sandbox.exports.installPerformanceProbe();
assert.equal(typeof probe?.exportMeasurements, 'function', 'Missing direct measurement export; disabled button traps captured data');
probe.exportMeasurements();
assert(Array.isArray(JSON.parse(nodes.find(node => node.id === 'configuration-performance').dataset.result).capturedEvents));
const entry = fs.readFileSync(path.join(root, 'test/fixtures/admin-configuration-browser/manual-entry.tsx'), 'utf8');
const start = entry.indexOf("document.addEventListener('click', event => {");
const end = entry.indexOf('\n}, true);', start) + '\n}, true);'.length;
assert(start >= 0 && end > start, 'Actual manual event handler missing');
let callback, exported = 0;
const progress = { closes: 0, guide: { textContent: '' }, probe: { exportMeasurements() { exported++; } },
  window: { setTimeout: action => action() }, document: { addEventListener: (_name, action) => { callback = action; } } };
vm.runInNewContext(ts.transpileModule(entry.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, progress);
const button = { disabled: false, getAttribute: () => '关闭' };
for (let i = 0; i < 24; i++) callback({ isTrusted: true, target: { closest: () => button } });
assert.equal(progress.closes, 24);
assert.equal(exported, 4, 'Fixed groups and surplus must remain exportable without a button');
assert.match(progress.guide.textContent, /已完成/);
callback({ isTrusted: false, target: { closest: () => button } });
assert.equal(exported, 4, 'Synthetic input must not advance manual collection');
console.log(JSON.stringify({ passed: true, checks: ['actual-probe-direct-export', 'actual-handler-fixed-and-surplus-auto-export', 'untrusted-input-not-counted'], browserInput: false, performanceClaim: false }));
