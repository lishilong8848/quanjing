import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('inventory outbound approval release safety', () => {
  it('ships the outbound approval schema gate in the runnable migration package', () => {
    const script = source('scripts/create-migration-package.ps1');

    expect(script).toContain(
      "Join-Path $repoRoot 'scripts/ensure-inventory-outbound-approval-fields.mjs'",
    );
    expect(script).toContain(
      "Join-Path $stageDir 'scripts/ensure-inventory-outbound-approval-fields.mjs'",
    );
    expect(script).toContain("Join-Path $repoRoot 'deploy/start.ps1'");
    expect(script).toContain("Join-Path $stageDir 'start.ps1'");
  });

  it('ships and atomically rolls back every root file required by the schema gate', () => {
    const script = source(
      'scripts/create-safe-full-runtime-hotfix-package.ps1',
    );

    expect(script).toContain('$releaseFileSources = [ordered]@{');
    for (const mapping of [
      "'package.json' = 'package.json'",
      "'package-lock.json' = 'package-lock.json'",
      "'start.ps1' = 'deploy/start.ps1'",
      "'start.cmd' = 'deploy/start.cmd'",
      "'scripts/run-with-env.mjs' = 'scripts/run-with-env.mjs'",
      "'scripts/ensure-inventory-outbound-approval-fields.mjs' = 'scripts/ensure-inventory-outbound-approval-fields.mjs'",
    ]) {
      expect(script).toContain(mapping);
    }
    expect(script).toContain("Join-Path $stageRoot 'release-root'");
    expect(script).toContain('releaseFiles = $releaseFiles');
    expect(script).toContain('Assert-ExactReleaseFileSet');
    expect(script).toContain('Switch-ReleaseFiles');
    expect(script).toContain('Restore-ReleaseFiles');
    expect(script).toContain('@($manifest.releaseFiles)');
  });

  it('fingerprints the actual deployed launchers instead of repository-only wrappers', () => {
    const script = source(
      'scripts/create-safe-full-runtime-hotfix-package.ps1',
    );

    expect(script).toContain('[string]$BaselineRoot');
    expect(script).toContain('$baseFileSources = [ordered]@{');
    expect(script).toContain("'start.ps1' = 'deploy/start.ps1'");
    expect(script).toContain("'start.cmd' = 'deploy/start.cmd'");
    expect(script).toContain(
      '$sourcePath = Join-Path $projectRoot $baseFileSources[$relativePath]',
    );
    expect(script).not.toContain(
      "$baseFiles = @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd')",
    );
  });

  it('restores replaced and newly added root payload files after a failed switch', () => {
    const packageSource = source(
      'scripts/create-safe-full-runtime-hotfix-package.ps1',
    );
    const installerMatch = packageSource.match(
      /\$installer = @'\r?\n([\s\S]*?)\r?\n'@\r?\nSet-Content -LiteralPath \(Join-Path \$stageRoot 'INSTALL-HOTFIX\.ps1'\)/u,
    );
    expect(installerMatch).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), 'outbound-release-root-'));
    const installerPath = join(directory, 'installer.ps1');
    const appRoot = join(directory, 'app');
    const stagedRoot = join(directory, 'staged');
    const backupRoot = join(directory, 'backup');
    const failedRoot = join(directory, 'failed');
    mkdirSync(join(appRoot, 'scripts'), { recursive: true });
    mkdirSync(join(stagedRoot, 'scripts'), { recursive: true });
    writeFileSync(join(appRoot, 'start.ps1'), 'old-start', 'utf8');
    writeFileSync(join(stagedRoot, 'start.ps1'), 'new-start', 'utf8');
    writeFileSync(
      join(
        stagedRoot,
        'scripts',
        'ensure-inventory-outbound-approval-fields.mjs',
      ),
      'new-migration',
      'utf8',
    );
    writeFileSync(installerPath, installerMatch![1], 'utf8');

    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$sourcePath = ${powerShellLiteral(installerPath)}`,
      '$tokens = $null',
      '$parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'installer parse failed' }",
      "$names = @('Assert-CanonicalRelativePath', 'Resolve-AppRootTargetPath', 'Move-ItemWithRetry', 'Switch-ReleaseFiles', 'Restore-ReleaseFiles')",
      '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
      "if ($definitions.Count -ne $names.Count) { throw 'installer function missing' }",
      'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
      `$root = ${powerShellLiteral(appRoot)}`,
      `$staged = ${powerShellLiteral(stagedRoot)}`,
      `$backup = ${powerShellLiteral(backupRoot)}`,
      `$failed = ${powerShellLiteral(failedRoot)}`,
      "$manifest = [pscustomobject]@{ releaseFiles = @([pscustomobject]@{ targetPath = 'start.ps1' }, [pscustomobject]@{ targetPath = 'scripts/ensure-inventory-outbound-approval-fields.mjs' }) }",
      "$state = New-Object 'System.Collections.Generic.List[object]'",
      'Switch-ReleaseFiles -Root $root -StagedRoot $staged -BackupRoot $backup -Manifest $manifest -State $state',
      "if ((Get-Content -LiteralPath (Join-Path $root 'start.ps1') -Raw) -ne 'new-start') { throw 'replacement was not installed' }",
      "if (!(Test-Path -LiteralPath (Join-Path $root 'scripts/ensure-inventory-outbound-approval-fields.mjs'))) { throw 'new migration was not installed' }",
      'Restore-ReleaseFiles -Root $root -State $state -FailedRoot $failed',
      "if ((Get-Content -LiteralPath (Join-Path $root 'start.ps1') -Raw) -ne 'old-start') { throw 'old launcher was not restored' }",
      "if (Test-Path -LiteralPath (Join-Path $root 'scripts/ensure-inventory-outbound-approval-fields.mjs')) { throw 'new-only migration remained after rollback' }",
      "if (!(Test-Path -LiteralPath (Join-Path $failed 'scripts/ensure-inventory-outbound-approval-fields.mjs'))) { throw 'failed migration was not quarantined' }",
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
        { cwd: ROOT, encoding: 'utf8', timeout: 20_000 },
      );
      expect(completed.error).toBeUndefined();
      if (completed.status !== 0) {
        throw new Error(
          `PowerShell root rollback harness failed (${completed.status}):\n${completed.stdout}\n${completed.stderr}`,
        );
      }
      expect(completed.stdout).toContain('RESULT_OK');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['start.ps1', 'deploy/start.ps1'])(
    '%s treats configured outbound approval as a callback workflow',
    (launcher) => {
      const script = source(launcher);
      const workflowStart = script.indexOf(
        'function Test-CardCallbackWorkflowEnabled',
      );
      const workflowEnd = script.indexOf(
        'function Test-LeaveWorkflowEnabled',
        workflowStart,
      );
      const workflowBlock = script.slice(workflowStart, workflowEnd);

      expect(script).toContain(
        'function Test-InventoryOutboundApprovalWorkflowEnabled',
      );
      for (const name of [
        'FEISHU_APP_ID',
        'FEISHU_APP_SECRET',
        'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
        'FEISHU_WAREHOUSE_APP_TOKEN',
        'FEISHU_WAREHOUSE_SOURCE_URL',
      ]) {
        expect(script).toContain(`'${name}'`);
      }
      expect(workflowBlock).toContain(
        'Test-InventoryOutboundApprovalWorkflowEnabled',
      );
    },
  );

  it.each(['start.ps1', 'deploy/start.ps1'])(
    '%s detects outbound approval only when all required configuration is present',
    (launcher) => {
      const launcherPath = resolve(ROOT, launcher);
      const harness = [
        "$ErrorActionPreference = 'Stop'",
        `$sourcePath = ${powerShellLiteral(launcherPath)}`,
        '$tokens = $null',
        '$parseErrors = $null',
        '$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)',
        "if ($parseErrors.Count -gt 0) { throw 'launcher parse failed' }",
        "$names = @('Get-DotEnvValue', 'Test-ConfiguredValuePresent', 'Test-InventoryOutboundApprovalWorkflowEnabled')",
        '$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)',
        "if ($definitions.Count -ne $names.Count) { throw 'required function missing' }",
        'foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }',
        "$keys = @('FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID', 'FEISHU_WAREHOUSE_APP_TOKEN', 'FEISHU_WAREHOUSE_SOURCE_URL')",
        'foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $null, [EnvironmentVariableTarget]::Process) }',
        '$envPath = [System.IO.Path]::GetTempFileName()',
        '$envLocalPath = [System.IO.Path]::GetTempFileName()',
        'try {',
        "  @('FEISHU_APP_ID=cli_test', 'FEISHU_APP_SECRET=redacted', 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID=tbl_outbound', 'FEISHU_WAREHOUSE_APP_TOKEN=app_token') | Set-Content -LiteralPath $envPath -Encoding UTF8",
        "  Set-Content -LiteralPath $envLocalPath -Value '' -Encoding UTF8",
        "  if (!(Test-InventoryOutboundApprovalWorkflowEnabled -EnvPath $envPath -EnvLocalPath $envLocalPath)) { throw 'complete config was not enabled' }",
        "  @('FEISHU_APP_ID=cli_test', 'FEISHU_APP_SECRET=redacted', 'FEISHU_WAREHOUSE_APP_TOKEN=app_token') | Set-Content -LiteralPath $envPath -Encoding UTF8",
        "  if (Test-InventoryOutboundApprovalWorkflowEnabled -EnvPath $envPath -EnvLocalPath $envLocalPath) { throw 'missing outbound table was enabled' }",
        "  Write-Output 'RESULT_OK'",
        '} finally {',
        '  Remove-Item -LiteralPath $envPath, $envLocalPath -Force -ErrorAction SilentlyContinue',
        '}',
      ].join('\r\n');

      const completed = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-EncodedCommand',
          Buffer.from(harness, 'utf16le').toString('base64'),
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: 20_000 },
      );

      expect(completed.error).toBeUndefined();
      expect(completed.status).toBe(0);
      expect(completed.stdout).toContain('RESULT_OK');
    },
  );

  it('keeps the watchdog callback probe aligned with outbound approval startup', () => {
    const script = source('deploy/watchdog.ps1');
    const workflowStart = script.indexOf(
      'function Test-CardCallbackWorkflowEnabled',
    );
    const workflowEnd = script.indexOf(
      'function Test-CardCallbackConsumerEnabled',
      workflowStart,
    );
    const workflowBlock = script.slice(workflowStart, workflowEnd);

    expect(script).toContain(
      'function Test-InventoryOutboundApprovalWorkflowEnabled',
    );
    expect(workflowBlock).toContain(
      'Test-InventoryOutboundApprovalWorkflowEnabled',
    );
  });
});
