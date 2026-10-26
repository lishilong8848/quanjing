'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = file => digest(fs.readFileSync(file));
const inside = file => file === root || file.startsWith(root + path.sep);

if (process.env.AVATAR_TYPE_CAPTURE_DIRECTORY) {
  const directory = process.env.AVATAR_TYPE_CAPTURE_DIRECTORY;
  if (!path.isAbsolute(directory) || !inside(directory)) throw new Error('CAPTURE_DIRECTORY_REJECTED');
  const originalRead = fs.readFileSync;
  const reads = new Map();
  fs.readFileSync = function (file, ...args) {
    const value = originalRead.call(this, file, ...args);
    if (typeof file === 'string') {
      const absolute = path.resolve(file);
      if (inside(absolute) && /\.(?:ts|tsx|js|jsx|cjs|mjs|json)$/.test(absolute)) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, typeof args[0] === 'string' ? args[0] : args[0]?.encoding || 'utf8');
        const hash = digest(bytes);
        const prior = reads.get(absolute);
        if (prior && prior.sha256 !== hash) throw new Error('TYPE_INPUT_CHANGED_DURING_READ');
        reads.set(absolute, { path: absolute, sha256: hash });
      }
    }
    return value;
  };
  process.on('exit', () => {
    const inputs = [...reads.values()].sort((a, b) => a.path.localeCompare(b.path));
    fs.writeFileSync(path.join(directory, 'actual-cli-reads.json'), JSON.stringify(inputs, null, 2));
  });
} else if (require.main === module) {
  const { spawnSync } = require('node:child_process');
  const cli = path.join(root, 'node_modules/typescript/bin/tsc');
  const suffix = new Date().toISOString().replace(/[^0-9]/g, '');
  const directory = path.join(root, 'output/user-name-avatar-check/client-types-' + suffix);
  fs.mkdirSync(directory);
  const files = new Set([__filename, process.execPath, cli,
    path.join(root, 'node_modules/typescript/lib/tsc.js'),
    path.join(root, 'node_modules/typescript/lib/_tsc.js'),
    ...['package.json', 'package-lock.json', 'tsconfig.app.json'].map(file => path.join(root, file))]);
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:ts|tsx|js|jsx|json)$/.test(file)) files.add(file);
    }
  }
  for (const folder of ['client', 'shared']) walk(path.join(root, folder));
  const snapshot = () => [...files].sort().map(file => ({ path: file, sha256: sha(file) }));
  const before = snapshot();
  const args = ['--require', __filename, cli, '--project', 'tsconfig.app.json', '--noEmit', '--incremental', 'false'];
  const evidence = { startedAt: new Date().toISOString(), node: { path: process.execPath, version: process.version, sha256: sha(process.execPath) }, args, before,
    boundary: 'One affected client type check. Actual CLI reads captured in the child; no server check, Jest, compiler build, browser, packaging or external writes. This is not a complete physical development dependency-tree proof.' };
  fs.writeFileSync(path.join(directory, 'inputs-before.json'), JSON.stringify(evidence, null, 2));
  const began = performance.now();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
      NODE_DISABLE_COMPILE_CACHE: '1', FORCE_COLOR: '0', AVATAR_TYPE_CAPTURE_DIRECTORY: directory } });
  evidence.elapsedMs = performance.now() - began;
  evidence.exitCode = result.status;
  evidence.signal = result.signal;
  evidence.spawnErrorCode = result.error?.code || null;
  fs.writeFileSync(path.join(directory, 'client-types.log'), (result.stdout || '') + (result.stderr || ''));
  const capture = path.join(directory, 'actual-cli-reads.json');
  evidence.actualReads = fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, 'utf8')) : [];
  evidence.actualReadMismatches = evidence.actualReads.filter(item => !fs.existsSync(item.path) || sha(item.path) !== item.sha256).map(item => item.path);
  evidence.after = snapshot();
  evidence.inputsStable = JSON.stringify(before) === JSON.stringify(evidence.after);
  evidence.completedAt = new Date().toISOString();
  evidence.passed = result.status === 0 && evidence.actualReads.length > 0 && evidence.actualReadMismatches.length === 0 && evidence.inputsStable;
  const target = path.join(directory, 'validation-evidence.json');
  fs.writeFileSync(target, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, exitCode: result.status, elapsedMs: evidence.elapsedMs, beforeCount: before.length,
    actualReadCount: evidence.actualReads.length, actualReadMismatches: evidence.actualReadMismatches, inputsStable: evidence.inputsStable, evidence: target, sha256: sha(target) }));
  if (!evidence.passed) process.exitCode = 1;
}
