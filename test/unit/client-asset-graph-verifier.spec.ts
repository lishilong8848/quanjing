import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const verifierPath = resolve(
  __dirname,
  '../../scripts/verify-client-asset-graph.mjs',
);

const createClientFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'client-asset-graph-'));
  mkdirSync(join(root, 'chunks'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'overtime-confirmation'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    '<link rel="stylesheet" href="/main.css"><script src="/main.js"></script>',
    'utf8',
  );
  writeFileSync(
    join(root, 'main.js'),
    [
      '(()=>{var h={};',
      'h.u=e=>"chunks/"+e+"."+({1:"aaaaaaaa"})[e]+".js";',
      'h.k=e=>"2"===e?"main.css":"chunks/"+e+"."+({2:"bbbbbbbb"})[e]+".css";',
      '})();',
    ].join(''),
    'utf8',
  );
  writeFileSync(join(root, 'main.css'), 'body{}', 'utf8');
  writeFileSync(
    join(root, 'chunks', '1.aaaaaaaa.js'),
    'globalThis.__chunkLoaded=true;',
    'utf8',
  );
  writeFileSync(
    join(root, 'chunks', '2.bbbbbbbb.css'),
    '.fixture{}',
    'utf8',
  );
  writeFileSync(join(root, 'assets', 'logo.svg'), '<svg/>', 'utf8');
  writeFileSync(join(root, 'polyfills.js'), 'globalThis.fixture=true;', 'utf8');
  writeFileSync(
    join(root, 'overtime-confirmation', 'index.html'),
    '<main>overtime</main>',
    'utf8',
  );
  return root;
};

const runVerifier = (root: string) =>
  spawnSync('node', [verifierPath, '--root', root, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  });

describe('client asset graph verifier', () => {
  it('accepts a complete main/chunk asset graph', () => {
    const root = createClientFixture();
    try {
      const result = runVerifier(root);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.runtimeVariable).toBe('h');
      expect(report.expectedAssets).toEqual([
        'assets/logo.svg',
        'index.html',
        'main.css',
        'main.js',
        'overtime-confirmation/index.html',
        'polyfills.js',
        'chunks/1.aaaaaaaa.js',
        'chunks/2.bbbbbbbb.css',
      ]);
      expect(report.activeStaticAssets).toEqual([
        'assets/logo.svg',
        'index.html',
        'main.css',
        'main.js',
        'overtime-confirmation/index.html',
        'polyfills.js',
      ]);
      expect(report.missingAssets).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('fails closed when main references a missing chunk', () => {
    const root = createClientFixture();
    try {
      unlinkSync(join(root, 'chunks', '1.aaaaaaaa.js'));
      const result = runVerifier(root);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'Missing client assets: chunks/1.aaaaaaaa.js',
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('ignores unreferenced historical chunks while preserving the active graph', () => {
    const root = createClientFixture();
    try {
      const before = runVerifier(root);
      expect(before.status).toBe(0);
      writeFileSync(
        join(root, 'chunks', '9999.deadbeef.js'),
        'globalThis.__historical=true;',
        'utf8',
      );
      const after = runVerifier(root);
      expect(after.status).toBe(0);
      expect(JSON.parse(after.stdout).expectedAssets).toEqual(
        JSON.parse(before.stdout).expectedAssets,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
