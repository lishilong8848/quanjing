import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const powerShellLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

describe('deploy/start.ps1 app process identity', () => {
  it('stops a same-port legacy relative-path app and leaves its lock for atomic server recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-ledger-owner-'));
    const mainDirectory = join(directory, 'dist', 'server');
    const mainFile = join(mainDirectory, 'main.js');
    const ledgerDirectory = join(directory, '.runtime');
    const ledgerPath = join(ledgerDirectory, 'purchase-workflow-ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const readyPath = join(directory, 'listener.ready');
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    mkdirSync(mainDirectory, { recursive: true });
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(
      mainFile,
      [
        "const http = require('http');",
        "const fs = require('fs');",
        'const port = Number(process.argv[2]);',
        "http.createServer((_request, response) => response.end('ok'))",
        "  .listen(port, '127.0.0.1', () => fs.writeFileSync(process.argv[3], 'ready'));",
      ].join('\n'),
      'utf8',
    );

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$names = @('Stop-ListeningProcessesOnPort', 'Resolve-PurchaseWorkflowLedgerLock')",
      '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
      "if ($definitions.Count -ne $names.Count) { throw 'required startup functions are missing' }",
      'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
      `$root = ${powerShellLiteral(directory)}`,
      `$main = ${powerShellLiteral(mainFile)}`,
      `$ledger = ${powerShellLiteral(ledgerPath)}`,
      `$lock = ${powerShellLiteral(lockPath)}`,
      `$ready = ${powerShellLiteral(readyPath)}`,
      `$node = ${powerShellLiteral(process.execPath)}`,
      '$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)',
      '$portProbe.Start()',
      '$port = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port',
      '$portProbe.Stop()',
      "$managed = Start-Process -FilePath $node -ArgumentList @('dist/server/main.js', [string]$port, ('\"' + $ready + '\"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru",
      'try {',
      '  $deadline = (Get-Date).AddSeconds(5)',
      '  do {',
      '    if (Test-Path -LiteralPath $ready) { break }',
      '    Start-Sleep -Milliseconds 50',
      '  } while ((Get-Date) -lt $deadline)',
      "  if (!(Test-Path -LiteralPath $ready)) { throw 'legacy relative-path owner did not listen' }",
      "  @{ pid = $managed.Id; instanceId = 'legacy-relative-owner' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lock -Encoding UTF8",
      '  Stop-ListeningProcessesOnPort -Port $port',
      '  Resolve-PurchaseWorkflowLedgerLock -Root $root -MainFile $main -LedgerPath $ledger',
      '  $managed.WaitForExit(5000) | Out-Null',
      "  if (!$managed.HasExited) { throw 'legacy relative-path owner was not stopped' }",
      "  if (!(Test-Path -LiteralPath $lock)) { throw 'launcher removed a lock reserved for atomic server recovery' }",
      "  Write-Output 'RESULT_OK'",
      '} finally {',
      '  if (!$managed.HasExited) { Stop-Process -Id $managed.Id -Force -ErrorAction SilentlyContinue }',
      '}',
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });

  it('preserves a newer process when a stale ledger lock contains its reused PID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-ledger-reused-pid-'));
    const mainDirectory = join(directory, 'dist', 'server');
    const mainFile = join(mainDirectory, 'main.js');
    const ledgerDirectory = join(directory, '.runtime');
    const ledgerPath = join(ledgerDirectory, 'purchase-workflow-ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    mkdirSync(mainDirectory, { recursive: true });
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(mainFile, 'setInterval(() => {}, 1000);\n', 'utf8');

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$name = 'Resolve-PurchaseWorkflowLedgerLock'",
      '$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
      'Invoke-Expression $definition.Extent.Text',
      `$root = ${powerShellLiteral(directory)}`,
      `$main = ${powerShellLiteral(mainFile)}`,
      `$ledger = ${powerShellLiteral(ledgerPath)}`,
      `$lock = ${powerShellLiteral(lockPath)}`,
      `$node = ${powerShellLiteral(process.execPath)}`,
      "$unrelated = Start-Process -FilePath $node -ArgumentList 'dist/server/main.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru",
      'try {',
      "  @{ pid = $unrelated.Id; instanceId = 'stale-reused-pid' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lock -Encoding UTF8",
      '  (Get-Item -LiteralPath $lock).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(-10)',
      '  Resolve-PurchaseWorkflowLedgerLock -Root $root -MainFile $main -LedgerPath $ledger',
      '  Start-Sleep -Milliseconds 300',
      "  if ($unrelated.HasExited) { throw 'newer reused-PID process was stopped' }",
      "  if (Test-Path -LiteralPath $lock) { throw 'stale reused-PID ledger lock was not removed' }",
      "  Write-Output 'RESULT_OK'",
      '} finally {',
      '  if (!$unrelated.HasExited) { Stop-Process -Id $unrelated.Id -Force -ErrorAction SilentlyContinue }',
      '}',
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });

  it('preserves a live relative-path Node process from another app root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-ledger-current-'));
    const otherDirectory = mkdtempSync(
      join(tmpdir(), 'schedule-ledger-unrelated-'),
    );
    const mainDirectory = join(directory, 'dist', 'server');
    const otherMainDirectory = join(otherDirectory, 'dist', 'server');
    const mainFile = join(mainDirectory, 'main.js');
    const otherMainFile = join(otherMainDirectory, 'main.js');
    const ledgerDirectory = join(directory, '.runtime');
    const ledgerPath = join(ledgerDirectory, 'purchase-workflow-ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    mkdirSync(mainDirectory, { recursive: true });
    mkdirSync(otherMainDirectory, { recursive: true });
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(mainFile, 'setInterval(() => {}, 1000);\n', 'utf8');
    writeFileSync(otherMainFile, 'setInterval(() => {}, 1000);\n', 'utf8');

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$name = 'Resolve-PurchaseWorkflowLedgerLock'",
      '$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
      'Invoke-Expression $definition.Extent.Text',
      `$root = ${powerShellLiteral(directory)}`,
      `$otherRoot = ${powerShellLiteral(otherDirectory)}`,
      `$main = ${powerShellLiteral(mainFile)}`,
      `$ledger = ${powerShellLiteral(ledgerPath)}`,
      `$lock = ${powerShellLiteral(lockPath)}`,
      `$node = ${powerShellLiteral(process.execPath)}`,
      "$unrelated = Start-Process -FilePath $node -ArgumentList 'dist/server/main.js' -WorkingDirectory $otherRoot -WindowStyle Hidden -PassThru",
      'try {',
      '  Start-Sleep -Milliseconds 300',
      "  @{ pid = $unrelated.Id; instanceId = 'cross-root-relative-process' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lock -Encoding UTF8",
      '  Resolve-PurchaseWorkflowLedgerLock -Root $root -MainFile $main -LedgerPath $ledger',
      '  Start-Sleep -Milliseconds 300',
      "  if ($unrelated.HasExited) { throw 'cross-root relative process was stopped' }",
      "  if (!(Test-Path -LiteralPath $lock)) { throw 'live cross-root owner lock was removed' }",
      "  Write-Output 'RESULT_OK'",
      '} finally {',
      '  if (!$unrelated.HasExited) { Stop-Process -Id $unrelated.Id -Force -ErrorAction SilentlyContinue }',
      '}',
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      for (const target of [directory, otherDirectory]) {
        rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        });
      }
    }
  });

  it('leaves a dead-owner lock for server-side atomic recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-ledger-dead-'));
    const mainDirectory = join(directory, 'dist', 'server');
    const mainFile = join(mainDirectory, 'main.js');
    const ledgerDirectory = join(directory, '.runtime');
    const ledgerPath = join(ledgerDirectory, 'purchase-workflow-ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    mkdirSync(mainDirectory, { recursive: true });
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(mainFile, 'setInterval(() => {}, 1000);\n', 'utf8');

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$name = 'Resolve-PurchaseWorkflowLedgerLock'",
      '$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
      'Invoke-Expression $definition.Extent.Text',
      `$root = ${powerShellLiteral(directory)}`,
      `$main = ${powerShellLiteral(mainFile)}`,
      `$ledger = ${powerShellLiteral(ledgerPath)}`,
      `$lock = ${powerShellLiteral(lockPath)}`,
      '$deadPid = 2147483000',
      'while (Get-Process -Id $deadPid -ErrorAction SilentlyContinue) { $deadPid -= 1 }',
      "@{ pid = $deadPid; instanceId = 'dead-owner' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lock -Encoding UTF8",
      'Resolve-PurchaseWorkflowLedgerLock -Root $root -MainFile $main -LedgerPath $ledger',
      "if (!(Test-Path -LiteralPath $lock)) { throw 'dead-owner lock was deleted outside server recovery' }",
      "Write-Output 'RESULT_OK'",
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });

  it('stops the recorded app but preserves a process when its start time does not match', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schedule-app-pid-'));
    const mainDirectory = join(directory, 'dist', 'server');
    const mainFile = join(mainDirectory, 'main.js');
    const pidFile = join(directory, 'app.pid');
    const startScript = resolve(__dirname, '../../deploy/start.ps1');
    mkdirSync(mainDirectory, { recursive: true });
    writeFileSync(mainFile, 'setInterval(() => {}, 1000);\n', 'utf8');

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(startScript)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'start.ps1 parse failed' }",
      "$names = @('Write-AppPidFile', 'Stop-PidFileProcess')",
      '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
      'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
      `$root = ${powerShellLiteral(directory)}`,
      `$main = ${powerShellLiteral(mainFile)}`,
      `$pidFile = ${powerShellLiteral(pidFile)}`,
      `$node = ${powerShellLiteral(process.execPath)}`,
      "$managed = Start-Process -FilePath $node -ArgumentList ('\"' + $main + '\"') -WorkingDirectory $root -WindowStyle Hidden -PassThru",
      'try {',
      '  Write-AppPidFile -PidFile $pidFile -Process $managed -Root $root -MainFile $main',
      '  Stop-PidFileProcess -PidFile $pidFile -ExpectedRoot $root -ExpectedMainFile $main',
      '  $managed.WaitForExit(5000) | Out-Null',
      "  if (!$managed.HasExited) { throw 'matching app process was not stopped' }",
      "  $staleTarget = Start-Process -FilePath $node -ArgumentList ('\"' + $main + '\"') -WorkingDirectory $root -WindowStyle Hidden -PassThru",
      '  try {',
      "    $staleRecord = [ordered]@{ pid = $staleTarget.Id; startTime = (Get-Date).AddDays(-1).ToUniversalTime().ToString('o'); appRoot = [IO.Path]::GetFullPath($root); mainFile = [IO.Path]::GetFullPath($main) }",
      '    $staleRecord | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -Encoding UTF8',
      '    Stop-PidFileProcess -PidFile $pidFile -ExpectedRoot $root -ExpectedMainFile $main',
      '    Start-Sleep -Milliseconds 300',
      "    if ($staleTarget.HasExited) { throw 'stale PID record stopped an unrelated process' }",
      '  } finally {',
      '    if (!$staleTarget.HasExited) { Stop-Process -Id $staleTarget.Id -Force -ErrorAction SilentlyContinue }',
      '  }',
      "  Write-Output 'RESULT_OK'",
      '} finally {',
      '  if (!$managed.HasExited) { Stop-Process -Id $managed.Id -Force -ErrorAction SilentlyContinue }',
      '}',
    ].join('\r\n');

    try {
      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });

  it('uses guarded atomic quarantine instead of deleting the active lock path', () => {
    const script = readFileSync(
      resolve(__dirname, '../../deploy/start.ps1'),
      'utf8',
    );
    const recoveryStart = script.indexOf(
      'function Resolve-PurchaseWorkflowLedgerLock',
    );
    const recoveryBlock = script.slice(
      recoveryStart,
      script.indexOf('function Get-FileSha256', recoveryStart),
    );

    expect(recoveryBlock).toContain('[System.IO.FileMode]::CreateNew');
    expect(recoveryBlock).toContain('[System.IO.File]::Move');
    expect(recoveryBlock).not.toContain(
      'Remove-Item -LiteralPath $lockPath',
    );
  });

  it('treats an owner exiting between identity verification and kill as stopped', () => {
    const script = readFileSync(
      resolve(__dirname, '../../deploy/start.ps1'),
      'utf8',
    );
    const recoveryStart = script.indexOf(
      'function Resolve-PurchaseWorkflowLedgerLock',
    );
    const recoveryBlock = script.slice(
      recoveryStart,
      script.indexOf('function Get-FileSha256', recoveryStart),
    );

    expect(recoveryBlock).toMatch(
      /\$confirmedOwner\.Kill\(\)[\s\S]*?catch\s*\{[\s\S]*?\$confirmedOwner\.Refresh\(\)[\s\S]*?if \(!\$confirmedOwner\.HasExited\)\s*\{\s*throw/,
    );
  });
});
