import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const packageScript = resolve(
  'scripts/create-unified-access-config-argument-hotfix.ps1',
);
const payloadPaths = [
  'scripts/configure-unified-access.ps1',
  'scripts/configure-inventory-access.ps1',
  'scripts/configure-purchase-access.ps1',
  'README_UNIFIED_ACCESS_ARGUMENT_HOTFIX.md',
] as const;

describe('unified access configuration argument minimal hotfix package', () => {
  let temporaryDirectory = '';
  let baselineStage = '';
  let outputDirectory = '';

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'access-argument-hotfix-'));
    baselineStage = join(temporaryDirectory, 'baseline');
    outputDirectory = join(temporaryDirectory, 'output');
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates a five-file delta while preserving the complete verified baseline manifest', () => {
    writeBaseline(baselineStage, {
      'dist/server/main.js': 'baseline-main',
      'scripts/configure-unified-access.ps1': 'old-unified-wrapper',
      'scripts/configure-inventory-access.ps1': 'old-inventory-wrapper',
      'README_UNIFIED_ACCESS_RECOVERY.md': 'baseline-readme',
    });

    runPackage(baselineStage, outputDirectory);

    const zipPath = findSingleOutput(outputDirectory, '.zip');
    const entries = listArchiveEntries(zipPath);
    expect(entries).toEqual(
      [...payloadPaths, 'hotfix-manifest.json'].sort(),
    );

    const manifest = readArchiveManifest(zipPath);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      'dist/server/main.js',
      'README_UNIFIED_ACCESS_ARGUMENT_HOTFIX.md',
      'README_UNIFIED_ACCESS_RECOVERY.md',
      'scripts/configure-inventory-access.ps1',
      'scripts/configure-purchase-access.ps1',
      'scripts/configure-unified-access.ps1',
    ]);

    const baselineMain = manifest.files.find(
      (entry) => entry.path === 'dist/server/main.js',
    );
    expect(baselineMain?.sha256).toBe(sha256('baseline-main'));

    for (const payloadPath of payloadPaths) {
      const entry = manifest.files.find((item) => item.path === payloadPath);
      expect(entry?.sha256).toBe(
        createHash('sha256')
          .update(readArchiveEntry(zipPath, payloadPath))
          .digest('hex')
          .toUpperCase(),
      );
    }

    const sidecarPath = `${zipPath}.sha256.txt`;
    const sidecar = readFileSync(sidecarPath, 'utf8').trim();
    const archiveHash = createHash('sha256')
      .update(readFileSync(zipPath))
      .digest('hex')
      .toUpperCase();
    expect(sidecar).toBe(`${archiveHash}  ${zipPath.split(/[\\/]/).at(-1)}`);
  });

  it('rejects a baseline whose declared file hash no longer matches', () => {
    writeBaseline(baselineStage, {
      'dist/server/main.js': 'verified-before-tampering',
    });
    writeFileSync(
      join(baselineStage, 'dist/server/main.js'),
      'tampered-after-manifest',
      'utf8',
    );

    const result = runPackageFailure(baselineStage, outputDirectory);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/integrity|hash/i);
    expect(readdirSync(outputDirectory, { recursive: true })).toHaveLength(0);
  });

  it('fails fast when a payload wrapper omits the Node argument separator', () => {
    writeBaseline(baselineStage, {
      'dist/server/main.js': 'baseline-main',
    });
    const fakeRoot = join(temporaryDirectory, 'fake-repo');
    const fakeScript = join(
      fakeRoot,
      'scripts/create-unified-access-config-argument-hotfix.ps1',
    );
    mkdirSync(dirname(fakeScript), { recursive: true });
    mkdirSync(join(fakeRoot, 'deploy'), { recursive: true });
    writeFileSync(fakeScript, readFileSync(packageScript));
    writeFileSync(
      join(fakeRoot, 'scripts/configure-unified-access.ps1'),
      '& $nodeCommand.Source $nodeScript "--target=$Target"',
      'utf8',
    );
    writeFileSync(
      join(fakeRoot, 'scripts/configure-inventory-access.ps1'),
      "& $nodeCommand.Source '--' $nodeScript \"--target=$Target\"",
      'utf8',
    );
    writeFileSync(
      join(fakeRoot, 'scripts/configure-purchase-access.ps1'),
      "$arguments = @('--', $nodeScript, \"--target=$Target\")",
      'utf8',
    );
    writeFileSync(
      join(fakeRoot, 'deploy/README_UNIFIED_ACCESS_ARGUMENT_HOTFIX.md'),
      'argument hotfix readme',
      'utf8',
    );

    const result = runPackageFailure(
      baselineStage,
      join(temporaryDirectory, 'invalid-output'),
      fakeScript,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /argument separator|corrected wrapper/i,
    );
  });

  it.each([
    '.env',
    '.env.local',
    'data/private.json',
    'logs/app.log',
    'certs/server.key',
    '.runtime/node/node.exe',
    'node_modules/pkg/index.js',
  ])('rejects forbidden baseline path %s', (forbiddenPath) => {
    writeBaseline(baselineStage, {
      'dist/server/main.js': 'baseline-main',
      [forbiddenPath]: 'must-not-be-packaged',
    });

    const result = runPackageFailure(baselineStage, outputDirectory);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/forbidden/i);
  });
});

interface Manifest {
  schemaVersion: number;
  files: Array<{ path: string; sha256: string }>;
}

function writeBaseline(
  root: string,
  files: Record<string, string>,
): void {
  const entries = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => {
      const destination = join(root, ...path.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, 'utf8');
      return { path, sha256: sha256(content) };
    });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'hotfix-manifest.json'),
    JSON.stringify({ schemaVersion: 1, files: entries }, null, 2),
    'utf8',
  );
}

function runPackage(baseline: string, output: string): void {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      packageScript,
      '-BaselineStage',
      baseline,
      '-OutputDir',
      output,
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
}

function runPackageFailure(
  baseline: string,
  output: string,
  script = packageScript,
) {
  mkdirSync(output, { recursive: true });
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-BaselineStage',
      baseline,
      '-OutputDir',
      output,
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
}

function findSingleOutput(directory: string, suffix: string): string {
  const matches = readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(directory, name));
  expect(matches).toHaveLength(1);
  return matches[0];
}

function listArchiveEntries(zipPath: string): string[] {
  return execFileSync('tar.exe', ['-tf', zipPath], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .sort();
}

function readArchiveManifest(zipPath: string): Manifest {
  return JSON.parse(
    readArchiveEntry(zipPath, 'hotfix-manifest.json')
      .toString('utf8')
      .replace(/^\uFEFF/, ''),
  ) as Manifest;
}

function readArchiveEntry(zipPath: string, path: string): Buffer {
  return execFileSync('tar.exe', ['-xOf', zipPath, path], {
    windowsHide: true,
  });
}

function sha256(content: string): string {
  return createHash('sha256')
    .update(content)
    .digest('hex')
    .toUpperCase();
}
