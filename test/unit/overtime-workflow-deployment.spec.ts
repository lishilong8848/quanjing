import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function probeNativeCommandCapture(
  scriptPath: string,
  exitCode: number,
): { exitCode: number; output: string } {
  const absolutePath = resolve(root, scriptPath).replace(/'/g, "''");
  const command = [
    '$tokens = $null',
    '$parseErrors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${absolutePath}', [ref]$tokens, [ref]$parseErrors)`,
    'if ($parseErrors.Count -gt 0) { exit 2 }',
    "$functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NativeCommandCaptured' }, $true)",
    'if ($null -eq $functionAst) { exit 3 }',
    'Invoke-Expression $functionAst.Extent.Text',
    `$result = Invoke-NativeCommandCaptured -Executable $env:ComSpec -Arguments @('/d', '/s', '/c', 'echo npm notice 1>&2 & exit /b ${exitCode}')`,
    '[ordered]@{ exitCode = $result.ExitCode; output = [string]::Join("`n", @($result.Output)) } | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', command],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `PowerShell probe failed for ${scriptPath}: ${result.stderr || result.stdout}`,
    );
  }

  return JSON.parse(result.stdout.trim()) as {
    exitCode: number;
    output: string;
  };
}

describe('overtime workflow deployment contract', () => {
  it('exposes explicit dry-run and apply migration commands', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(
      packageJson.scripts['migrate:overtime-workflow-fields:dry-run'],
    ).toBe(
      'node scripts/run-with-env.mjs node scripts/ensure-overtime-workflow-fields.mjs --dry-run',
    );
    expect(packageJson.scripts['migrate:overtime-workflow-fields:check']).toBe(
      'node scripts/run-with-env.mjs node scripts/ensure-overtime-workflow-fields.mjs --dry-run --require-ready',
    );
    expect(packageJson.scripts['migrate:overtime-workflow-fields']).toBe(
      'node scripts/run-with-env.mjs node scripts/ensure-overtime-workflow-fields.mjs --apply',
    );
  });

  it('keeps the durable ledger outside the replaceable release by default', () => {
    for (const path of ['start.ps1', 'deploy/start.ps1']) {
      const script = source(path);
      expect(script).toContain("'nantong-schedule-state'");
      expect(script).toContain("'overtime-workflow-ledger.json'");
      expect(script).toContain('$env:OVERTIME_WORKFLOW_LEDGER_PATH');
      expect(script).toContain('[System.IO.Path]::GetFullPath');
    }
  });

  it('packages migration tooling and the operator runbook', () => {
    const script = source('scripts/create-migration-package.ps1');
    const migration = source('scripts/ensure-overtime-workflow-fields.mjs');

    expect(script).toContain("'scripts/run-with-env.mjs'");
    expect(script).toContain("'scripts/ensure-overtime-workflow-fields.mjs'");
    expect(script).toContain("'scripts/self-test-overtime-workflow.mjs'");
    expect(script).toContain(
      "'dist/server/modules/purchase-inventory/feishu-card-action.consumer.js'",
    );
    expect(script).toContain(
      "'dist/server/modules/purchase-inventory/feishu-card-action.router.js'",
    );
    expect(script).toContain(
      "'dist/server/modules/overtime-workflow/overtime-workflow.card-action.consumer.js'",
    );
    expect(script).toContain("$feishuSdkVersion -ne '1.73.0'");
    expect(script).toContain("'docs/runbooks/overtime-program-workflow.md'");
    expect(script).toContain("'README_OVERTIME_WORKFLOW.md'");
    expect(script).toContain('Assert-OvertimeWorkflowPackageContract');
    expect(script).toContain('Set-OvertimeWorkflowPackageCommands');
    expect(script).toContain(
      "Set-OvertimeWorkflowPackageCommands -PackagePath (Join-Path $stageDir 'package.json')",
    );
    expect(script).toContain(
      "'self-test:overtime-workflow:apply-real' = 'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --apply-real'",
    );
    expect(script).toContain('self-test:overtime-workflow:dry-run');
    expect(script).toContain('self-test:overtime-workflow:audit');
    expect(migration).toContain('/auth/v3/tenant_access_token/internal');
    expect(migration).toContain('/fields');
    expect(migration).toContain('LARK_OPENAPI_BASE_URL');
  });

  it('excludes accumulated source maps from the runnable migration package', () => {
    const script = source('scripts/create-migration-package.ps1');
    const copyDist = script.indexOf(
      "Copy-RequiredItem -Source (Join-Path $repoRoot 'dist') -Destination $distStagePath",
    );
    const sourceMapPath = script.indexOf(
      "$sourceMapsStagePath = Join-Path $distStagePath 'sourcemaps'",
    );
    const removeSourceMaps = script.indexOf(
      'Remove-Item -LiteralPath $sourceMapsStagePath -Recurse -Force',
    );

    expect(copyDist).toBeGreaterThan(-1);
    expect(sourceMapPath).toBeGreaterThan(copyDist);
    expect(removeSourceMaps).toBeGreaterThan(sourceMapPath);
  });

  it('gates startup on the non-writing workflow schema check after dependencies exist', () => {
    for (const path of ['start.ps1', 'deploy/start.ps1']) {
      const script = source(path);
      const dependencies = script.indexOf(
        'Ensure-ProductionDependencies -Root $appRoot -NpmPath $npmPath',
      );
      const gate = script.indexOf(
        'Assert-OvertimeWorkflowSchema -Root $appRoot -NpmPath $npmPath',
      );
      const firstStop = script.indexOf('\nStop-PidFileProcess', gate);
      const processStart = script.lastIndexOf('$process = Start-Process');

      expect(script).toContain('function Assert-OvertimeWorkflowSchema');
      expect(script).toContain("'scripts/run-with-env.mjs'");
      expect(script).toContain("'scripts/ensure-overtime-workflow-fields.mjs'");
      expect(script).toContain('migrate:overtime-workflow-fields:check');
      expect(script).toContain('OVERTIME_WORKFLOW_PROGRAM_ENABLED');
      expect(script).toContain('npm run migrate:overtime-workflow-fields');
      expect(script).not.toContain(
        'verify LARK_CLI_BIN and Feishu credentials/network',
      );
      expect(dependencies).toBeGreaterThan(-1);
      expect(gate).toBeGreaterThan(dependencies);
      expect(firstStop).toBeGreaterThan(gate);
      expect(processStart).toBeGreaterThan(gate);
    }
  });

  it('captures native stderr without treating a successful npm notice as a startup failure', () => {
    const rootStart = source('start.ps1');
    const deployStart = source('deploy/start.ps1');

    for (const script of [rootStart, deployStart]) {
      expect(script).toContain('function Invoke-NativeCommandCaptured');
      expect(script).toContain("-Arguments @('run', 'migrate:overtime-workflow-fields:check')");
      expect(script).toContain("-Arguments @('run', 'migrate:leave-workflow-fields:check')");
      expect(script).not.toContain(
        '@(& $NpmPath run migrate:overtime-workflow-fields:check 2>&1)',
      );
      expect(script).not.toContain(
        '@(& $NpmPath run migrate:leave-workflow-fields:check 2>&1)',
      );
    }

    for (const path of ['start.ps1', 'deploy/start.ps1']) {
      const success = probeNativeCommandCapture(path, 0);
      expect(success.exitCode).toBe(0);
      expect(success.output).toContain('npm notice');

      const failure = probeNativeCommandCapture(path, 7);
      expect(failure.exitCode).toBe(7);
      expect(failure.output).toContain('npm notice');
    }
  });

  it('documents the first-start migration gate and recovery command', () => {
    const runbook = source('docs/runbooks/overtime-program-workflow.md');

    expect(runbook).toContain('首次启动字段门禁');
    expect(runbook).toContain('缺少任一技术字段时会拒绝启动');
    expect(runbook).toContain('npm run migrate:overtime-workflow-fields');
    expect(runbook).toContain('只读门禁不依赖服务器全局 `lark-cli`');
  });

  it('gates startup on the realtime shared Feishu card callback health endpoint', () => {
    for (const path of ['start.ps1', 'deploy/start.ps1']) {
      const script = source(path);
      const callbackCheck = script.indexOf(
        'Wait-HealthyEndpoint -Url $cardCallbackHealthUrl',
      );
      const appReady = script.indexOf('[OK] App started. PID:', callbackCheck);
      const browserOpen = script.indexOf('Open-AppBrowser', appReady);

      expect(script).toContain('function Test-CardCallbackWorkflowEnabled');
      expect(script).toContain('function Test-CardCallbackConsumerEnabled');
      expect(script).toContain('FEISHU_CARD_ACTION_CONSUMER_ENABLED');
      expect(script).toContain("'.feishu-card-action-consumer-release'");
      expect(script).toContain(
        "$env:FEISHU_CARD_ACTION_CONSUMER_ENABLED = if ($cardCallbackConsumerEnabled) { 'true' } else { 'false' }",
      );
      expect(script).toContain('OVERTIME_WORKFLOW_PROGRAM_ENABLED');
      expect(script).toContain('PURCHASE_WORKFLOW_PROGRAM_ENABLED');
      expect(script).toContain('PURCHASE_MANAGER_APPROVAL_CARD_ENABLED');
      expect(script).toContain('$cardCallbackWorkflowEnabled');
      expect(script).toContain('CLIENT_BASE_PATH');
      expect(script).toContain('/api/feishu-card-callback/health');
      expect(script).toContain(
        'response.statusCode >= 200 && response.statusCode < 300',
      );
      expect(script).not.toContain(
        "Select-String -LiteralPath $stdout -SimpleMatch 'Feishu overtime card callback consumer: READY'",
      );
      expect(callbackCheck).toBeGreaterThan(-1);
      expect(appReady).toBeGreaterThan(callbackCheck);
      expect(browserOpen).toBeGreaterThan(appReady);
      expect(script).toContain('Feishu shared card callback is not online');
    }
  });

  it('makes the watchdog require realtime callback health when any card workflow is enabled', () => {
    const script = source('deploy/watchdog.ps1');

    expect(script).toContain("Join-Path $appRoot '.env.local'");
    expect(script).toContain('function Test-CardCallbackWorkflowEnabled');
    expect(script).toContain('function Test-CardCallbackConsumerEnabled');
    expect(script).toContain('FEISHU_CARD_ACTION_CONSUMER_ENABLED');
    expect(script).toContain("'.feishu-card-action-consumer-release'");
    expect(script).toContain('OVERTIME_WORKFLOW_PROGRAM_ENABLED');
    expect(script).toContain('PURCHASE_WORKFLOW_PROGRAM_ENABLED');
    expect(script).toContain('PURCHASE_MANAGER_APPROVAL_CARD_ENABLED');
    expect(script).toContain('CLIENT_BASE_PATH');
    expect(script).toContain('/api/feishu-card-callback/health');
    expect(script).toContain('--fail');
    expect(script).toContain('Card callback health check failed');
    expect(script).toContain('$CallbackFailureThreshold = 3');
    expect(script).toContain('$CallbackRetryDelaySeconds = 10');
    expect(script).toContain(
      'for ($attempt = 1; $attempt -le $failureThreshold; $attempt += 1)',
    );
    expect(script).toContain('Start-Sleep -Seconds $retryDelaySeconds');
    expect(
      script.indexOf('Test-HealthEndpoint -Url $appHealthUrl'),
    ).toBeLessThan(
      script.indexOf('Test-HealthEndpoint -Url $cardCallbackHealthUrl'),
    );
    expect(script).not.toContain(
      'Feishu overtime card callback consumer: READY',
    );
  });

  it('reapplies the audited Feishu card SDK patch before every service start', () => {
    const patchGate = source('scripts/ensure-feishu-card-ws-sdk-patch.mjs');
    expect(patchGate).toContain(
      "import { patchFeishuCardCallbackFrames } from './postinstall.mjs'",
    );
    expect(patchGate).toContain('patchFeishuCardCallbackFrames');
    expect(patchGate).toContain("status === 'not-installed'");

    for (const path of ['start.ps1', 'deploy/start.ps1']) {
      const script = source(path);
      const dependencies = script.indexOf(
        'Ensure-ProductionDependencies -Root $appRoot -NpmPath $npmPath',
      );
      const gate = script.indexOf(
        'Assert-FeishuCardCallbackSdkPatch -Root $appRoot -NodePath $nodePath',
      );
      const schema = script.indexOf(
        'Assert-OvertimeWorkflowSchema -Root $appRoot -NpmPath $npmPath',
      );
      const failedGateExit = script.indexOf('exit 1', gate);
      const processStart = script.lastIndexOf('$process = Start-Process');

      expect(script).toContain('function Assert-FeishuCardCallbackSdkPatch');
      expect(script).toContain("'scripts/ensure-feishu-card-ws-sdk-patch.mjs'");
      expect(script).toContain(
        "postinstallScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/postinstall.mjs')",
      );
      expect(script).toContain(
        "feishuCardPatchScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')",
      );
      expect(script).toContain(
        '$stamp.postinstallScript -eq $current.postinstallScript',
      );
      expect(script).toContain(
        '$stamp.feishuCardPatchScript -eq $current.feishuCardPatchScript',
      );
      expect(dependencies).toBeGreaterThan(-1);
      expect(gate).toBeGreaterThan(dependencies);
      expect(failedGateExit).toBeGreaterThan(gate);
      expect(failedGateExit).toBeLessThan(schema);
      expect(schema).toBeGreaterThan(gate);
      expect(processStart).toBeGreaterThan(gate);
    }

    const packageScript = source('scripts/create-migration-package.ps1');
    expect(packageScript).toContain(
      "Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-feishu-card-ws-sdk-patch.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')",
    );
    expect(packageScript).toContain(
      "postinstallScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/postinstall.mjs')",
    );
    expect(packageScript).toContain(
      "feishuCardPatchScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')",
    );
  });

  it('documents only non-secret workflow configuration placeholders', () => {
    const envExample = source('.env.example');

    expect(envExample).toContain('OVERTIME_WORKFLOW_PROGRAM_ENABLED=true');
    expect(envExample).toContain('FEISHU_CARD_ACTION_CONSUMER_ENABLED=');
    expect(envExample).toContain('OVERTIME_WORKFLOW_LEDGER_PATH=');
    expect(envExample).toContain('FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN=');
    expect(envExample).toContain('FEISHU_OVERTIME_CONFIRMATION_SECRET=');
  });

  it('marks only packaged releases as callback-consumer candidates', () => {
    const script = source('scripts/create-migration-package.ps1');

    expect(script).toContain("'.feishu-card-action-consumer-release'");
    expect(script).toContain('FEISHU_CARD_ACTION_CONSUMER_RELEASE_V1');
  });
});
