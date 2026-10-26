import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const source = resolve(__dirname, '../../scripts/install-hotfix-one-click.ps1');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe('actual PowerShell outer activation boundary', () => {
  let root: string, parent: string, owner: string;
  beforeEach(() => { parent = realpathSync(tmpdir()); root = mkdtempSync(join(parent, 'nt-outer-activation-')); owner = randomUUID(); writeFileSync(join(root, '.test-owner'), owner, { flag: 'wx' }); });
  afterEach(() => {
    const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (!same(dirname(root), parent) || !/^nt-outer-activation-[A-Za-z0-9]+$/.test(basename(root)) || !same(realpathSync(root), root) ||
        lstatSync(root).isSymbolicLink() || readFileSync(join(root, '.test-owner'), 'utf8') !== owner) throw Error('Unowned fixture');
    const check = (directory: string) => { for (const name of readdirSync(directory)) { const file = join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink() || !same(realpathSync(file), file)) throw Error('Unsafe fixture');
      if (stat.isDirectory()) check(file); else if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe entry');
    } }; check(root); rmSync(root, { recursive: true });
  });
  function run(body: string) {
    const harness = join(root, 'harness.ps1');
    writeFileSync(harness, `\uFEFF$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n$tokens=$null;$errors=$null\n$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$tokens,[ref]$errors)\nif($errors.Count -ne 0){throw 'Script syntax invalid'}\n${body}\n`, 'utf8');
    return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  }
  function invocation(exitCode: number) {
    const marker = join(root, 'observed.json'), probe = join(root, 'probe.cjs'), app = join(root, 'app with spaces'), payload = join(root, '包 with spaces');
    writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));process.exitCode=${exitCode};`);
    const result = run(`$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-HotfixActivationCheck'},$true)\nif(-not $fn){throw 'Missing activation wrapper'}\n. ([scriptblock]::Create($fn.Extent.Text))\nInvoke-HotfixActivationCheck -NodePath ${quote(process.execPath)} -VerifierPath ${quote(probe)} -Root ${quote(app)} -PackageRoot ${quote(payload)}`);
    return { marker, result, app, payload };
  }
  it('calls the actual Node verifier with argument boundaries preserved', () => {
    const { marker, result, app, payload } = invocation(0);
    expect(result.status).toBe(0); expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['--app-root', app, '--package-root', payload]);
  });
  it('propagates a verifier failure instead of returning outer success', () => {
    const { result } = invocation(31); expect(result.status).not.toBe(0); expect(result.stderr).toContain('activation');
  });
  function cleanup(activationCompleted: boolean) {
    const target = join(root, 'owned-recovery'), normalized = resolve(target); mkdirSync(target); writeFileSync(join(target, 'retain.txt'), 'synthetic recovery evidence');
    expect(dirname(realpathSync(target))).toBe(root);
    const result = run(`$installerStarted=$true;$installerCompleted=$true;$activationCompleted=$${activationCompleted}\n$tempRoot=${quote(target)}\nif([System.IO.Path]::GetFullPath($tempRoot) -cne ${quote(normalized)} -or (Get-Content -LiteralPath ${quote(join(root, '.test-owner'))} -Raw) -cne ${quote(owner)}){throw 'Unowned cleanup target'}\n$outer=$ast.Find({param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Finally -and $n.Finally.Extent.Text.Contains('$installerStarted')},$true)\nif(-not $outer){throw 'Missing original cleanup boundary'}\n$text=$outer.Finally.Extent.Text\n& ([scriptblock]::Create($text.Substring(1,$text.Length-2)))`);
    return { result, target };
  }
  it('retains recovery evidence when the inner commit succeeded but activation failed', () => {
    const { result, target } = cleanup(false); expect(result.status).toBe(0); expect(existsSync(join(target, 'retain.txt'))).toBe(true);
  });
  it('cleans owned staging only after both installation and activation completed', () => {
    const { result, target } = cleanup(true); expect(result.status).toBe(0); expect(existsSync(target)).toBe(false);
  });
  it('binds the verifier to release inputs and only marks activation after its checked call', () => {
    const outer = readFileSync(source, 'utf8'), builder = readFileSync(resolve(__dirname, '../../scripts/create-safe-full-runtime-hotfix-package.ps1'), 'utf8');
    expect(builder).toContain("'scripts/verify-hotfix-activation.cjs' = 'scripts/verify-hotfix-activation.cjs'");
    const install = outer.slice(outer.indexOf('$installerStarted = $true'));
    expect(install.indexOf('Invoke-HotfixActivationCheck')).toBeGreaterThan(install.indexOf('$installerCompleted = $true'));
    expect(install.indexOf('$activationCompleted = $true')).toBeGreaterThan(install.indexOf('Invoke-HotfixActivationCheck'));
    expect(install.indexOf('[OK]')).toBeGreaterThan(install.indexOf('$activationCompleted = $true'));
  });
});
