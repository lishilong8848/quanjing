import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const verifierPath = join(
  process.cwd(),
  'scripts/verify-construction-progress-client-baseline.mjs',
);

const writeFixture = (
  root: string,
  relativePath: string,
  content: string,
) => {
  const filePath = join(root, ...relativePath.split('/'));
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
};

const createClientFixture = (root: string, current: boolean) => {
  const hash = current ? 'bbbbbbbb' : 'aaaaaaaa';
  const buildTime = current
    ? '2026-07-23T04:15:55.439Z'
    : '2026-07-23T03:31:49.377Z';
  const hmrHash = current
    ? '3e15b4a35d70fe3e'
    : '97d37e0306d10f58';
  const stableChunk = current
    ? `(()=>{var e6=1;function e7(e){return e+e6}console.log(e7(2),"${buildTime}")})();`
    : `(()=>{var e7=1;function e6(e){return e+e7}console.log(e6(2),"${buildTime}")})();`;

  writeFixture(
    root,
    `chunks/1081.${hash}.js`,
    stableChunk,
  );
  writeFixture(
    root,
    `chunks/3668.${hash}.js`,
    current
      ? 'console.log("每日施工进展","当天开工前完成人员核查","完成进度");'
      : 'console.log("每日施工进展");',
  );
  writeFixture(
    root,
    'main.js',
    `const assets={1081:"${hash}"};runtime.h=()=>"${hmrHash}";`,
  );
  writeFixture(
    root,
    'polyfills.js',
    `runtime.h=()=>"${hmrHash}";`,
  );
  writeFixture(
    root,
    'main.css',
    current
      ? '.base{display:block}@layer utilities{@media (min-width:64rem){.lg\\:flex{display:flex}}}'
      : '.base{display:block}',
  );
  writeFixture(
    root,
    'main.legacy.css',
    current
      ? '.base{display:block}@media (min-width:64rem){.lg\\:flex{display:flex}}'
      : '.base{display:block}',
  );
  writeFixture(root, 'favicon.svg', '<svg></svg>');
};

describe('construction progress client baseline verifier', () => {
  let tempRoot: string;
  let baselineDir: string;
  let currentDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'construction-client-baseline-'));
    baselineDir = join(tempRoot, 'baseline');
    currentDir = join(tempRoot, 'current');
    mkdirSync(baselineDir);
    mkdirSync(currentDir);
    createClientFixture(baselineDir, false);
    createClientFixture(currentDir, true);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('accepts only build noise plus the construction chunk and lg flex rules', () => {
    const output = execFileSync(
      process.execPath,
      [
        verifierPath,
        baselineDir,
        currentDir,
        '--expected-count=7',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output);

    expect(result.clientFileCount).toBe(7);
    expect(result.changedJavaScript).toEqual(['chunks/3668.js']);
    expect(result.addedCssRules['main.css']).toEqual([
      '@layer utilities|@media (min-width:64rem)|.lg\\:flex{display:flex}',
    ]);
    expect(result.addedCssRules['main.legacy.css']).toEqual([
      '@media (min-width:64rem)|.lg\\:flex{display:flex}',
    ]);
  });

  it('rejects a logical change in any unrelated JavaScript chunk', () => {
    writeFixture(
      currentDir,
      'chunks/1081.bbbbbbbb.js',
      'console.log("unrelated functional change");',
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          verifierPath,
          baselineDir,
          currentDir,
          '--expected-count=7',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    ).toThrow();
  });
});
