import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const powerShellLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const requiredFunctions = [
  'Get-FileSha256',
  'Get-DependencyStampPath',
  'New-DependencyFingerprint',
  'Write-DependencyStamp',
  'Test-DependencyStamp',
  'Test-CriticalServerDependencies',
  'Test-ProductionDependencies',
  'Ensure-ProductionDependencies',
];

const previouslyCheckedDependencies = [
  '@nestjs/core',
  '@nestjs/common',
  '@nestjs/platform-express',
  '@nestjs/swagger',
  '@nestjs/axios',
  '@lark-apaas/fullstack-nestjs-core',
  'axios',
  'dotenv',
  'drizzle-orm',
  'hbs',
  'reflect-metadata',
  'rxjs',
  'tslib',
  'xlsx-js-style',
];

const runDependencyCheck = (
  directory: string,
  beforeCheck: string[] = [],
): boolean => {
  const startScript = resolve(__dirname, '../../deploy/start.ps1');
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    `$sourcePath = ${powerShellLiteral(startScript)}`,
    '$tokens = $null',
    '$parseErrors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
    "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
    `$names = @(${requiredFunctions.map(powerShellLiteral).join(', ')})`,
    '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
    'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
    `$root = ${powerShellLiteral(directory)}`,
    ...beforeCheck,
    '$result = Test-ProductionDependencies -Root $root',
    'Write-Output ("RESULT:" + [string][bool]$result)',
  ].join('\r\n');

  const completed = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(harness, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );

  if (completed.status !== 0 || completed.error) {
    throw new Error(
      `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
    );
  }

  const match = completed.stdout.match(/RESULT:(True|False)/i);
  if (!match) {
    throw new Error(`Dependency result missing:\n${completed.stdout}`);
  }
  return match[1].toLowerCase() === 'true';
};

const runDependencyEnsure = (
  directory: string,
  environment: Record<string, string | undefined>,
) => {
  const startScript = resolve(__dirname, '../../deploy/start.ps1');
  const npmMarker = join(directory, 'npm-was-called.txt');
  const fakeNpm = join(directory, 'fake-npm.cmd');
  writeFileSync(
    fakeNpm,
    `@echo off\r\necho called>${npmMarker}\r\nexit /b 91\r\n`,
    'utf8',
  );
  const environmentSetup = Object.entries(environment).map(([name, value]) =>
    value === undefined
      ? `[Environment]::SetEnvironmentVariable(${powerShellLiteral(name)}, $null, [EnvironmentVariableTarget]::Process)`
      : `[Environment]::SetEnvironmentVariable(${powerShellLiteral(name)}, ${powerShellLiteral(value)}, [EnvironmentVariableTarget]::Process)`,
  );
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    `$sourcePath = ${powerShellLiteral(startScript)}`,
    '$tokens = $null',
    '$parseErrors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
    "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
    `$names = @(${requiredFunctions.map(powerShellLiteral).join(', ')})`,
    '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
    'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
    `$root = ${powerShellLiteral(directory)}`,
    ...environmentSetup,
    `Ensure-ProductionDependencies -Root $root -NpmPath ${powerShellLiteral(fakeNpm)}`,
    "Write-Output 'ENSURE_COMPLETED'",
  ].join('\r\n');
  const completed = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(harness, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return {
    ...completed,
    npmCalled: existsSync(npmMarker),
  };
};

const installDeclaredCriticalDependency = (directory: string) => {
  const dependencyDirectory = join(
    directory,
    'node_modules',
    'cos-nodejs-sdk-v5',
  );
  mkdirSync(dependencyDirectory, { recursive: true });
  writeFileSync(
    join(dependencyDirectory, 'package.json'),
    JSON.stringify({ name: 'cos-nodejs-sdk-v5', version: '3.0.0' }),
    'utf8',
  );
};

describe('deploy/start.ps1 production dependency validation', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'production-dependencies-'));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@nestjs/core': '1.0.0',
          'cos-nodejs-sdk-v5': '3.0.0',
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
      'utf8',
    );
    for (const dependency of previouslyCheckedDependencies) {
      const dependencyDirectory = join(
        directory,
        'node_modules',
        ...dependency.split('/'),
      );
      mkdirSync(dependencyDirectory, {
        recursive: true,
      });
      writeFileSync(
        join(dependencyDirectory, 'package.json'),
        JSON.stringify({ name: dependency, version: '1.0.0' }),
        'utf8',
      );
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects a matching dependency stamp when a declared runtime module is missing', () => {
    const result = runDependencyCheck(directory, [
      'Write-DependencyStamp -Root $root',
    ]);

    expect(result).toBe(false);
  });

  it('does not bless existing module folders after the lock file changes', () => {
    const cosDirectory = join(directory, 'node_modules', 'cos-nodejs-sdk-v5');
    mkdirSync(cosDirectory, {
      recursive: true,
    });
    writeFileSync(
      join(cosDirectory, 'package.json'),
      JSON.stringify({ name: 'cos-nodejs-sdk-v5', version: '3.0.0' }),
      'utf8',
    );
    const changedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: { changed: { version: '1.0.0' } },
    });
    const result = runDependencyCheck(directory, [
      'Write-DependencyStamp -Root $root',
      `Set-Content -LiteralPath (Join-Path $root 'package-lock.json') -Value ${powerShellLiteral(changedLock)} -Encoding UTF8`,
    ]);

    expect(result).toBe(false);
  });

  it('keeps installed dependencies valid when only package scripts change', () => {
    installDeclaredCriticalDependency(directory);
    const packageJsonWithScripts = JSON.stringify({
      scripts: {
        start: 'node dist/server/main.js',
      },
      dependencies: {
        '@nestjs/core': '1.0.0',
        'cos-nodejs-sdk-v5': '3.0.0',
      },
    });
    const result = runDependencyCheck(directory, [
      'Write-DependencyStamp -Root $root',
      `Set-Content -LiteralPath (Join-Path $root 'package.json') -Value ${powerShellLiteral(packageJsonWithScripts)} -Encoding UTF8`,
    ]);

    expect(result).toBe(true);
  });

  it('uses an installer physical-tree proof without invoking npm when the dependency stamp differs', () => {
    installDeclaredCriticalDependency(directory);
    const result = runDependencyEnsure(directory, {
      NANTONG_ATOMIC_HOTFIX_MODE: 'verified-physical-tree',
      NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF: 'a'.repeat(64),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ENSURE_COMPLETED');
    expect(result.stdout).toContain('Atomic hotfix dependency proof accepted');
    expect(result.npmCalled).toBe(false);
    expect(existsSync(join(directory, '.deps-ready.json'))).toBe(false);
  });

  it.each([
    ['missing proof', undefined],
    ['malformed proof', 'not-a-physical-tree-fingerprint'],
  ])('fails closed for atomic mode with %s', (_label, proof) => {
    installDeclaredCriticalDependency(directory);
    const result = runDependencyEnsure(directory, {
      NANTONG_ATOMIC_HOTFIX_MODE: 'verified-physical-tree',
      NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF: proof,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Atomic hotfix dependency proof is missing or invalid',
    );
    expect(result.stdout).not.toContain('ENSURE_COMPLETED');
    expect(result.npmCalled).toBe(false);
  });

  it('fails closed for an unrecognized atomic hotfix mode', () => {
    installDeclaredCriticalDependency(directory);
    const result = runDependencyEnsure(directory, {
      NANTONG_ATOMIC_HOTFIX_MODE: 'true',
      NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF: 'a'.repeat(64),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Atomic hotfix dependency proof is missing or invalid',
    );
    expect(result.npmCalled).toBe(false);
  });

  it('fails closed when an atomically verified tree lacks a critical dependency', () => {
    const result = runDependencyEnsure(directory, {
      NANTONG_ATOMIC_HOTFIX_MODE: 'verified-physical-tree',
      NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF: 'a'.repeat(64),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Atomic hotfix dependency proof cannot replace missing critical modules',
    );
    expect(result.stdout).not.toContain('ENSURE_COMPLETED');
    expect(result.npmCalled).toBe(false);
  });

  it('refuses to invoke npm ci through a node_modules junction', () => {
    const sharedDependencies = join(directory, 'shared-node-modules');
    const sentinel = join(sharedDependencies, 'sentinel.txt');
    const npmMarker = join(directory, 'npm-was-called.txt');
    const fakeNpm = join(directory, 'fake-npm.cmd');
    mkdirSync(sharedDependencies);
    writeFileSync(sentinel, 'keep\n');
    rmSync(join(directory, 'node_modules'), { recursive: true, force: true });
    symlinkSync(
      sharedDependencies,
      join(directory, 'node_modules'),
      'junction',
    );
    writeFileSync(
      fakeNpm,
      `@echo off\r\necho called>${npmMarker}\r\nexit /b 0\r\n`,
      'utf8',
    );

    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      `$names = @(${requiredFunctions.map(powerShellLiteral).join(', ')})`,
      '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
      'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
      `$root = ${powerShellLiteral(directory)}`,
      `Ensure-ProductionDependencies -Root $root -NpmPath ${powerShellLiteral(fakeNpm)}`,
    ].join('\r\n');

    const completed = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-EncodedCommand',
        Buffer.from(harness, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );

    expect(completed.status).not.toBe(0);
    expect(completed.stdout).toContain(
      'Refusing to install dependencies through a node_modules reparse point',
    );
    expect(existsSync(npmMarker)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n');
  });
});
