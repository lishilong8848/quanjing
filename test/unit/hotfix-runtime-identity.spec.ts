import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const { writeRuntimeIdentity } = require('../../scripts/write-hotfix-runtime-identity.cjs') as {
  writeRuntimeIdentity(root: string, deploymentId: string): { path: string; sha256: string; size: number; deploymentId: string };
};
const deploymentId = 'nantong-safe-full-runtime-hotfix-20261016-000005';
const identityPath = 'dist/server/hotfix-runtime-identity.json';

describe('immutable runtime build identity', () => {
  let root: string, parent: string, owner: string;
  const built = () => { mkdirSync(join(root, 'dist/server'), { recursive: true }); writeFileSync(join(root, 'dist/server/main.js'), '// synthetic generated build'); };
  beforeEach(() => {
    parent = realpathSync(tmpdir()); root = mkdtempSync(join(parent, 'nt-runtime-identity-'));
    owner = randomUUID(); writeFileSync(join(root, '.test-owner'), owner, { flag: 'wx' });
  });
  afterEach(() => {
    const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (!same(dirname(root), parent) || !/^nt-runtime-identity-[A-Za-z0-9]+$/.test(basename(root)) ||
        !same(realpathSync(root), root) || lstatSync(root).isSymbolicLink() || readFileSync(join(root, '.test-owner'), 'utf8') !== owner) throw Error('Unowned fixture');
    const check = (directory: string) => { for (const name of readdirSync(directory)) {
      const file = join(directory, name), stat = lstatSync(file);
      if (file === join(root, 'dist') && stat.isSymbolicLink()) { unlinkSync(file); continue; }
      if (stat.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture');
      if (stat.isDirectory()) check(file); else if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe fixture entry');
    } };
    check(root); rmSync(root, { recursive: true });
  });
  it('generates deterministic identity bytes and their SHA for the completed runtime', () => {
    built(); const result = writeRuntimeIdentity(root, deploymentId), bytes = readFileSync(join(root, identityPath));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId });
    expect(result).toEqual({ deploymentId, path: identityPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  });
  it('never replaces an existing stamp, including one from the same deployment', () => {
    built(); const target = join(root, identityPath), original = Buffer.from('prior identity must remain'); writeFileSync(target, original);
    expect(() => writeRuntimeIdentity(root, deploymentId)).toThrow('HOTFIX_IDENTITY_ALREADY_EXISTS');
    expect(readFileSync(target)).toEqual(original);
  });
  it('rejects invalid deployment identifiers before writing', () => {
    built(); for (const value of ['', '../candidate', 'candidate', deploymentId + '\n']) {
      expect(() => writeRuntimeIdentity(root, value)).toThrow('HOTFIX_IDENTITY_INVALID_DEPLOYMENT');
    }
    expect(readdirSync(join(root, 'dist/server'))).toEqual(['main.js']);
  });
  it('requires completed main output and an absolute controlled root', () => {
    expect(() => writeRuntimeIdentity(root, deploymentId)).toThrow('HOTFIX_IDENTITY_MISSING_MAIN');
    expect(() => writeRuntimeIdentity('.', deploymentId)).toThrow('HOTFIX_IDENTITY_INVALID_ROOT');
  });
  it('refuses to stamp a managed running or installed application root', () => {
    built(); writeFileSync(join(root, '.hotfix-installed-release.json'), '{}');
    expect(() => writeRuntimeIdentity(root, deploymentId)).toThrow('HOTFIX_IDENTITY_MANAGED_ROOT');
    expect(readdirSync(join(root, 'dist/server'))).toEqual(['main.js']);
  });
  it('rejects a reparse parent without writing through the junction', () => {
    const target = join(root, 'linked-target'); mkdirSync(join(target, 'server'), { recursive: true });
    writeFileSync(join(target, 'server/main.js'), '// synthetic'); symlinkSync(target, join(root, 'dist'), 'junction');
    expect(() => writeRuntimeIdentity(root, deploymentId)).toThrow('HOTFIX_IDENTITY_UNSAFE_PATH');
    expect(readdirSync(join(target, 'server'))).toEqual(['main.js']);
  });
  it('runs the actual Node CLI with structured output and rejects unsupported arguments', () => {
    built(); const script = resolve(__dirname, '../../scripts/write-hotfix-runtime-identity.cjs');
    const result = spawnSync(process.execPath, [script, '--build-root', root, '--deployment-id', deploymentId], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ deploymentId, path: identityPath, size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const invalid = spawnSync(process.execPath, [script, '--build-root', root, '--deployment-id', deploymentId, '--overwrite'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain('HOTFIX_IDENTITY_INVALID_ARGUMENTS');
  });
  it('is bound into the build source allowlist and called before the production runtime fingerprint', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
    const allowlist = source.slice(source.indexOf('$buildFileAllowlist = @('), source.indexOf('$cleanBuildWorkspaceRoot ='));
    expect(allowlist).toContain("'scripts/write-hotfix-runtime-identity.cjs'");
    const build = source.slice(source.indexOf("$productionBuildArguments = @('run', 'build:prod'"), source.indexOf('$runtimeGateScript ='));
    expect(build).toContain("'Runtime build identity'");
    expect(build.indexOf('write-hotfix-runtime-identity.cjs')).toBeLessThan(build.indexOf('$expectedBuildFingerprint ='));
    expect(build).toContain("'--deployment-id', $packageId");
  });
});
