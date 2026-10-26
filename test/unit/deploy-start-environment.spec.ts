import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('deploy/start.ps1 runtime environment', () => {
  const script = readFileSync(
    resolve(__dirname, '../../deploy/start.ps1'),
    'utf8',
  );
  const rootStartScript = readFileSync(
    resolve(__dirname, '../../start.ps1'),
    'utf8',
  );
  const contractPreviewInstaller = readFileSync(
    resolve(
      __dirname,
      '../../scripts/install-contract-preview-python-deps.ps1',
    ),
    'utf8',
  );
  const migrationPackager = readFileSync(
    resolve(__dirname, '../../scripts/create-migration-package.ps1'),
    'utf8',
  );
  const sslConfigurationScript = readFileSync(
    resolve(__dirname, '../../deploy/apply-ssl-env.ps1'),
    'utf8',
  );
  const purchaseConfigScriptPath = resolve(
    __dirname,
    '../../scripts/ensure-purchase-inventory-config.mjs',
  );
  const stopScript = readFileSync(
    resolve(__dirname, '../../deploy/stop.ps1'),
    'utf8',
  );
  const contractPreviewDependencyBlock = script.slice(
    script.indexOf('function Ensure-ContractPreviewDependencies'),
    script.indexOf('function Get-BrowserCommand'),
  );
  const environmentBlock = script.slice(
    script.indexOf('$databaseUrl ='),
    script.indexOf('$configuredPort ='),
  );
  const rootEnvironmentBlock = rootStartScript.slice(
    rootStartScript.indexOf('$databaseUrl ='),
    rootStartScript.indexOf('$configuredPort ='),
  );
  const runtimeBlock = script.slice(
    script.indexOf('$appRoot = Resolve-AppRoot'),
  );
  const readinessBlock = script.slice(
    script.indexOf('function Wait-AppReady'),
    script.indexOf('function Open-AppBrowser'),
  );
  const startupDiagnosticsBlock = script.slice(
    script.indexOf('function Write-AppStartupDiagnostics'),
    script.indexOf('function Test-AppUrlWithNode'),
  );
  const browserBlock = script.slice(
    script.indexOf('function Open-AppBrowser'),
    script.indexOf('function Write-AppPidFile'),
  );
  const stopPidBlock = stopScript.slice(
    stopScript.indexOf('function Stop-PidFileProcess'),
    stopScript.indexOf('function Stop-ListeningProcessesOnPort'),
  );
  const launchers = [
    ['deployment', script],
    ['root', rootStartScript],
  ] as const;

  it.each(launchers)(
    '%s launcher configures UTF-8 before capturing native command output',
    (_label, launcher) => {
      const initializationBlock = launcher.slice(
        0,
        launcher.indexOf('function Resolve-AppRoot'),
      );

      expect(initializationBlock).toContain(
        '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
      );
      expect(initializationBlock).toContain(
        '[Console]::InputEncoding = $utf8NoBom',
      );
      expect(initializationBlock).toContain(
        '[Console]::OutputEncoding = $utf8NoBom',
      );
      expect(initializationBlock).toContain('$OutputEncoding = $utf8NoBom');
    },
  );

  it('switches both command launchers to UTF-8 before PowerShell starts', () => {
    for (const path of ['start.cmd', 'deploy/start.cmd']) {
      const launcher = readFileSync(
        resolve(__dirname, `../../${path}`),
        'utf8',
      );
      expect(launcher).toMatch(/chcp 65001 >nul[\s\S]*powershell\.exe/i);
    }
  });

  it.each(launchers)(
    '%s launcher detaches the server standard input from the calling console',
    (_label, launcher) => {
      expect(launcher).toContain("$stdin = Join-Path $logDir 'app.stdin'");
      expect(launcher).toContain('-RedirectStandardInput $stdin');
    },
  );

  it('always starts the server with NODE_ENV=production', () => {
    expect(environmentBlock).toMatch(
      /\$env:NODE_ENV\s*=\s*'production'[\s\S]*if \(\$databaseUrl\.Trim\(\)\)/,
    );
    expect(environmentBlock).not.toContain("$env:NODE_ENV = 'development'");
  });

  it('keeps the root launcher in production mode without a database', () => {
    expect(rootEnvironmentBlock).toMatch(
      /\$env:NODE_ENV\s*=\s*'production'[\s\S]*if \(\$databaseUrl\.Trim\(\)\)/,
    );
    expect(rootEnvironmentBlock).not.toContain("$env:NODE_ENV = 'development'");
  });

  it('enables and validates leave card workflow in the root one-click launcher', () => {
    expect(rootStartScript).toContain(
      "Test-ConfiguredWorkflowFlag -Name 'LEAVE_WORKFLOW_PROGRAM_ENABLED' -DefaultEnabled $true",
    );
    expect(rootStartScript).toContain(
      "$env:LEAVE_WORKFLOW_PROGRAM_ENABLED = if ($leaveWorkflowEnabled) { 'true' } else { 'false' }",
    );
    expect(rootStartScript).toContain('Assert-LeaveWorkflowSchema');
    expect(rootStartScript).toContain('$env:LEAVE_WORKFLOW_LEDGER_PATH');
    for (const launcher of [rootStartScript, script]) {
      expect(launcher).toContain('LEAVE_WORKFLOW_STARTUP_RECOVERY_CODES');
      expect(launcher).not.toContain('XJ-920-');
      expect(launcher).not.toContain('XJ-921-');
      expect(launcher).toContain("$leaveStartupRecoveryCodes = ''");
    }
  });

  it.each(launchers)(
    '%s launcher honors an explicit leave-workflow false value',
    (_label, launcher) => {
      const leaveFlagBlock = launcher.slice(
        launcher.indexOf('function Test-LeaveWorkflowEnabled'),
        launcher.indexOf('function Test-CardCallbackConsumerEnabled'),
      );

      expect(leaveFlagBlock).not.toContain(
        'Old hot packages wrote false into .env',
      );
      expect(leaveFlagBlock).toMatch(/return \$configured\s*\}/u);
    },
  );

  it.each(launchers)(
    '%s launcher migrates leave and weather dedupe state outside the release directory',
    (_label, launcher) => {
      expect(launcher).toContain('function Copy-LegacyStateFileIfMissing');
      expect(launcher).toContain(
        "'nantong-schedule-state') 'leave-workflow-ledger.json'",
      );
      expect(launcher).toContain(
        "'nantong-schedule-state') 'weather-warning-automation-state.json'",
      );
      expect(launcher).toContain(
        '$env:FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH =',
      );
      expect(launcher).toContain(
        "Join-Path $appRoot 'data/leave-workflow/ledger.json'",
      );
      expect(launcher).toContain(
        "Join-Path $appRoot 'data/weather-warning-automation-state.json'",
      );
    },
  );

  it.each(launchers)(
    '%s launcher only gates inventory outbound fields when that workflow is fully configured',
    (_label, launcher) => {
      expect(launcher).toContain(
        '$inventoryOutboundApprovalEnabled = Test-InventoryOutboundApprovalWorkflowEnabled',
      );
      expect(launcher).toMatch(
        /if \(\$inventoryOutboundApprovalEnabled -and !\(Assert-InventoryOutboundApprovalSchema/,
      );
    },
  );

  it('explicitly disables Datapass only when the database URL is absent', () => {
    expect(environmentBlock).toMatch(
      /if \(\$databaseUrl\.Trim\(\)\)\s*\{\s*\$env:FORCE_FRAMEWORK_DISABLE_DATAPASS\s*=\s*'false'[\s\S]*?\}\s*else\s*\{\s*\$env:FORCE_FRAMEWORK_DISABLE_DATAPASS\s*=\s*'true'/,
    );
  });

  it('uses .env.local as the final database URL source', () => {
    expect(script).toContain("$envLocalFile = Join-Path $appRoot '.env.local'");
    expect(environmentBlock).toMatch(
      /\$databaseUrl\s*=\s*Get-DotEnvValue -FilePath \$envFile -Name 'SUDA_DATABASE_URL' -DefaultValue ''\s*\$databaseUrl\s*=\s*Get-DotEnvValue -FilePath \$envLocalFile -Name 'SUDA_DATABASE_URL' -DefaultValue \$databaseUrl/,
    );
  });

  it.each(launchers)(
    '%s launcher uses .env.local as the final listener and TLS source',
    (_label, launcher) => {
      expect(launcher).toContain(
        "$envLocalFile = Join-Path $appRoot '.env.local'",
      );
      const configurationBlock = launcher.slice(
        launcher.indexOf('$configuredPort ='),
        launcher.indexOf('$scheme ='),
      );
      for (const [variableName, dotenvName] of [
        ['configuredPort', 'SERVER_PORT'],
        ['configuredHost', 'SERVER_HOST'],
        ['httpsCertPath', 'HTTPS_CERT_PATH'],
        ['httpsKeyPath', 'HTTPS_KEY_PATH'],
        ['httpsCaPath', 'HTTPS_CA_PATH'],
      ] as const) {
        expect(configurationBlock).toMatch(
          new RegExp(
            `\\$${variableName}\\s*=\\s*Get-DotEnvValue -FilePath \\$envFile -Name '${dotenvName}'[\\s\\S]*?` +
              `\\$${variableName}\\s*=\\s*Get-DotEnvValue -FilePath \\$envLocalFile -Name '${dotenvName}' -DefaultValue \\$${variableName}`,
          ),
        );
      }
    },
  );

  it.each(launchers)(
    '%s launcher passes its final listener and TLS settings to the server process',
    (_label, launcher) => {
      const runtimeConfigurationBlock = launcher.slice(
        launcher.indexOf('$configuredPort ='),
        launcher.indexOf('$process = Start-Process'),
      );
      for (const [environmentName, variableName] of [
        ['SERVER_PORT', 'configuredPort'],
        ['SERVER_HOST', 'configuredHost'],
        ['HTTPS_CERT_PATH', 'httpsCertPath'],
        ['HTTPS_KEY_PATH', 'httpsKeyPath'],
        ['HTTPS_CA_PATH', 'httpsCaPath'],
      ] as const) {
        expect(runtimeConfigurationBlock).toContain(
          `$env:${environmentName} = $${variableName}`,
        );
      }
    },
  );

  it.each(launchers)(
    '%s launcher rejects an expired configured HTTPS certificate before launch',
    (_label, launcher) => {
      expect(launcher).toContain('function Test-HttpsCertificateReady');
      expect(launcher).toContain(
        '[System.Security.Cryptography.X509Certificates.X509Certificate2]',
      );
      expect(launcher).toContain('HTTPS certificate expired');
      expect(launcher).toContain('Replace the certificate and private key');

      const configuredCertificate = launcher.indexOf('$httpsCertPath =');
      const preflight = launcher.indexOf(
        'if (!(Test-HttpsCertificateReady -Root $appRoot -CertificatePath $httpsCertPath -PrivateKeyPath $httpsKeyPath))',
      );
      const processStart = launcher.indexOf('$process = Start-Process');

      expect(preflight).toBeGreaterThan(configuredCertificate);
      expect(processStart).toBeGreaterThan(preflight);
      expect(launcher.slice(preflight, processStart)).toMatch(
        /if \(!\(Test-HttpsCertificateReady[\s\S]*?exit 1/,
      );
    },
  );

  it('rejects expired certificates before writing HTTPS environment values', () => {
    const validation = sslConfigurationScript.slice(
      sslConfigurationScript.indexOf('function Assert-CertificateNames'),
      sslConfigurationScript.indexOf('function Set-EnvValues'),
    );

    expect(validation).toContain(
      '[System.Security.Cryptography.X509Certificates.X509Certificate2]',
    );
    expect(validation).toContain('$certificate.NotBefore');
    expect(validation).toContain('$certificate.NotAfter');
    expect(validation).toContain('Certificate has expired');
    expect(
      sslConfigurationScript.indexOf('Assert-CertificateNames'),
    ).toBeLessThan(sslConfigurationScript.indexOf('Set-EnvValues -EnvFile'));
  });

  it.each(launchers)(
    '%s launcher safely restores missing COS credentials from Windows user environment',
    (_label, launcher) => {
      expect(launcher).toContain('function Import-UserEnvironmentFallback');
      const startupBlock = launcher.slice(
        launcher.indexOf('$appRoot = Resolve-AppRoot'),
        launcher.indexOf('$process = Start-Process'),
      );
      const fallbackIndex = startupBlock.indexOf(
        'Import-UserEnvironmentFallback -Names @(',
      );
      expect(fallbackIndex).toBeGreaterThanOrEqual(0);
      for (const variableName of [
        'COS_SECRET_ID',
        'COS_SECRET_KEY',
        'COS_SESSION_TOKEN',
        'TENCENTCLOUD_SECRET_ID',
        'TENCENTCLOUD_SECRET_KEY',
        'TENCENTCLOUD_SESSION_TOKEN',
      ]) {
        expect(startupBlock).toContain(`'${variableName}'`);
      }
      expect(startupBlock).toMatch(
        /Change attachment object storage credentials: (?:READY|NOT CONFIGURED)/,
      );
    },
  );

  it.each(launchers)(
    '%s launcher probes the public, dependency-free session endpoint',
    (_label, launcher) => {
      expect(launcher).toContain(
        '$readinessUrl = "${scheme}://${hostForUrl}:$configuredPort${clientBasePath}/api/access/session"',
      );
      expect(launcher).toMatch(
        /Wait-AppReady\s+-Url\s+\$readinessUrl(?:\s+-NodePath\s+\$nodePath)?/,
      );
    },
  );

  it('automatically repairs missing purchase inventory configuration before dependency installation', () => {
    expect(script).toContain('function Ensure-PurchaseInventoryConfig');
    expect(script).toContain('ensure-purchase-inventory-config.mjs');

    const repairIndex = runtimeBlock.indexOf(
      'Ensure-PurchaseInventoryConfig -Root $appRoot -NodePath $nodePath',
    );
    const dependencyIndex = runtimeBlock.indexOf(
      'Ensure-ProductionDependencies -Root $appRoot',
    );

    expect(repairIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyIndex).toBeGreaterThan(repairIndex);
    expect(migrationPackager).toContain(
      'scripts/ensure-purchase-inventory-config.mjs',
    );
    expect(migrationPackager).toContain('README_PURCHASE_APPROVAL_HOTFIX.md');
    expect(() => readFileSync(purchaseConfigScriptPath, 'utf8')).not.toThrow();
  });

  it('automatically enables the purchase workflow only in the candidate process after configuration validation', () => {
    expect(script).toMatch(
      /function Ensure-PurchaseInventoryConfig[\s\S]*?\[switch\]\$ActivateWorkflow/,
    );
    expect(script).toMatch(
      /if \(\$ActivateWorkflow\)[\s\S]*?--activate-workflow/,
    );
    expect(runtimeBlock).toContain(
      'Ensure-PurchaseInventoryConfig -Root $appRoot -NodePath $nodePath -ActivateWorkflow',
    );
    expect(runtimeBlock).toMatch(
      /if \(\$purchaseWorkflowAutoEnable -and \$purchaseInventoryConfigReady\)[\s\S]*?\$env:PURCHASE_WORKFLOW_PROGRAM_ENABLED\s*=\s*'true'[\s\S]*?\$env:PURCHASE_MANAGER_APPROVAL_CARD_ENABLED\s*=\s*'true'[\s\S]*?\$env:FEISHU_CARD_ACTION_CONSUMER_PROFILE\s*=\s*'production'/,
    );
    expect(runtimeBlock).not.toMatch(
      /(?:Set-Content|Add-Content|Out-File)[^\r\n]*PURCHASE_(?:WORKFLOW_PROGRAM|MANAGER_APPROVAL_CARD)_ENABLED/,
    );

    const activationIndex = runtimeBlock.indexOf(
      "$env:PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true'",
    );
    const processStartIndex = runtimeBlock.indexOf('$process = Start-Process');
    expect(activationIndex).toBeGreaterThanOrEqual(0);
    expect(processStartIndex).toBeGreaterThan(activationIndex);
  });

  it('assigns the production callback consumer role when purchase workflow activation succeeds', () => {
    expect(runtimeBlock).toContain(
      "$env:FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'production'",
    );
    expect(runtimeBlock).toMatch(
      /\$cardCallbackConsumerEnabled\s*=\s*if \(\$purchaseWorkflowAutoEnable -and \$purchaseInventoryConfigReady\)[\s\S]*?\$true[\s\S]*?Test-CardCallbackConsumerEnabled/,
    );
  });

  it('supports an explicit emergency opt-out while defaulting automatic activation on', () => {
    expect(runtimeBlock).toContain('PURCHASE_WORKFLOW_AUTO_ENABLE_ON_START');
    expect(runtimeBlock).toMatch(
      /Get-DotEnvValue[\s\S]*?-Name 'PURCHASE_WORKFLOW_AUTO_ENABLE_ON_START'[\s\S]*?-DefaultValue 'true'/,
    );
    expect(runtimeBlock).toMatch(
      /if \(\$purchaseWorkflowAutoEnable\)[\s\S]*?Ensure-PurchaseInventoryConfig[^\r\n]*-ActivateWorkflow[\s\S]*?else[\s\S]*?Ensure-PurchaseInventoryConfig(?![^\r\n]*-ActivateWorkflow)/,
    );
  });

  it('refuses to start an enabled purchase workflow with incomplete configuration', () => {
    expect(runtimeBlock).toContain(
      '$purchaseInventoryConfigReady = if ($purchaseWorkflowAutoEnable)',
    );
    expect(runtimeBlock).toContain(
      "Get-DotEnvValue -FilePath $envFile -Name 'PURCHASE_WORKFLOW_PROGRAM_ENABLED'",
    );
    expect(runtimeBlock).toMatch(
      /if \(\$purchaseWorkflowEnabled -and !\$purchaseInventoryConfigReady\)[\s\S]*?exit 1/,
    );
  });

  it('stops before dependency installation when automatic workflow activation validation fails', () => {
    expect(runtimeBlock).toContain(
      'if ($purchaseWorkflowAutoEnable -and !$purchaseInventoryConfigReady)',
    );
    expect(runtimeBlock).toMatch(
      /if \(\$purchaseWorkflowAutoEnable -and !\$purchaseInventoryConfigReady\)[\s\S]*?\[ERROR\][\s\S]*?exit 1/,
    );

    const failureIndex = runtimeBlock.indexOf(
      'if ($purchaseWorkflowAutoEnable -and !$purchaseInventoryConfigReady)',
    );
    const dependencyIndex = runtimeBlock.indexOf(
      'Ensure-ProductionDependencies -Root $appRoot',
    );
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyIndex).toBeGreaterThan(failureIndex);
  });

  it('prefers a non-empty process database URL and falls back to dotenv for blank values', () => {
    expect(environmentBlock).toMatch(
      /\$databaseUrl\s*=\s*\$env:SUDA_DATABASE_URL\s*if \(\[string\]::IsNullOrWhiteSpace\(\$databaseUrl\)\)\s*\{[\s\S]*?\$databaseUrl\s*=\s*Get-DotEnvValue -FilePath \$envFile[\s\S]*?\$databaseUrl\s*=\s*Get-DotEnvValue -FilePath \$envLocalFile[\s\S]*?\}/,
    );
  });

  it.each(launchers)(
    '%s launcher reports standalone Feishu/local-cache operation as informational',
    (_label, launcher) => {
      expect(launcher).toContain(
        "Write-Host '[INFO] SUDA_DATABASE_URL is empty. Starting in standalone Feishu/local-cache mode.'",
      );
      expect(launcher).not.toContain(
        "Write-Host '[WARN] SUDA_DATABASE_URL is empty. Starting in standalone Feishu/local-cache mode.'",
      );
    },
  );

  it.each(launchers)(
    '%s launcher explains every checked source when COS credentials are unavailable',
    (_label, launcher) => {
      expect(launcher).toContain(
        'Checked current process, Windows User/Machine environment, .env and .env.local; change attachment upload is unavailable.',
      );
    },
  );

  it('starts a missing contract preview dependency install without blocking app startup', () => {
    expect(contractPreviewDependencyBlock).toContain(
      'System.Diagnostics.ProcessStartInfo',
    );
    expect(contractPreviewDependencyBlock).toContain(
      'UseShellExecute = $false',
    );
    expect(contractPreviewDependencyBlock).toContain('CreateNoWindow = $true');
    expect(contractPreviewDependencyBlock).toContain('-EncodedCommand');
    expect(contractPreviewDependencyBlock).not.toContain(
      '-RedirectStandardOutput',
    );
    expect(contractPreviewDependencyBlock).not.toContain(
      '-RedirectStandardError',
    );
    expect(contractPreviewDependencyBlock).not.toMatch(
      /&\s+powershell\.exe[\s\S]*?-File\s+\$installer/,
    );
  });

  it('publishes a readiness marker for the server-side contract queue gate', () => {
    expect(script).toContain('$env:CONTRACT_PREVIEW_READY_FILE');
    expect(contractPreviewDependencyBlock).toContain('Set-Content');
  });

  it('claims the preview installer atomically and tracks its lifetime without process queries', () => {
    expect(contractPreviewDependencyBlock).toContain(
      '[System.IO.FileMode]::CreateNew',
    );
    expect(contractPreviewDependencyBlock).toContain(
      'CONTRACT_PREVIEW_INSTALL_OWNER_TOKEN',
    );
    expect(contractPreviewDependencyBlock).toContain(
      'contract-preview-install.running',
    );
    expect(contractPreviewDependencyBlock).not.toContain(
      'Get-CimInstance Win32_Process',
    );
    expect(contractPreviewDependencyBlock).not.toContain('Get-Process');
    expect(contractPreviewDependencyBlock).not.toContain('.StartTime');
    expect(contractPreviewDependencyBlock).toContain(
      'contract-preview-install.guard',
    );
    expect(contractPreviewDependencyBlock).toContain(
      '[System.IO.FileShare]::None',
    );
  });

  it('lets only the owning preview installer remove the shared PID file', () => {
    expect(contractPreviewInstaller).toMatch(
      /Get-Content[\s\S]*?ownerToken[\s\S]*?\$PID[\s\S]*?Remove-Item/,
    );
  });

  it('removes runtime log files from the staged production dist directory', () => {
    expect(migrationPackager).toMatch(
      /Join-Path \$stageDir 'dist'[\s\S]*?\.Extension -eq '\.log'[\s\S]*?Remove-Item/,
    );
  });

  it('stops the old Node service before changing the shared preview readiness marker', () => {
    const stopIndex = runtimeBlock.indexOf('Stop-AllScheduleNodeProcesses');
    const ensurePreviewIndex = runtimeBlock.indexOf(
      '[void](Ensure-ContractPreviewDependencies',
    );

    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(ensurePreviewIndex).toBeGreaterThan(stopIndex);
  });

  it('rechecks the listener and purchase ledger owner immediately before launching', () => {
    const startProcessIndex = runtimeBlock.indexOf('$process = Start-Process');
    const ledgerRecoveryIndex = runtimeBlock.indexOf(
      'Resolve-PurchaseWorkflowLedgerLock',
    );
    const listenerChecks = [
      ...runtimeBlock.matchAll(/Stop-ListeningProcessesOnPort/g),
    ].map((match) => match.index ?? -1);

    expect(script).toContain('function Resolve-PurchaseWorkflowLedgerLock');
    expect(runtimeBlock).toContain(
      "Get-DotEnvValue -FilePath $envFile -Name 'PURCHASE_WORKFLOW_LEDGER_PATH'",
    );
    expect(runtimeBlock).toContain(
      "Get-DotEnvValue -FilePath $envLocalFile -Name 'PURCHASE_WORKFLOW_LEDGER_PATH'",
    );
    expect(listenerChecks).toHaveLength(2);
    expect(listenerChecks[1]).toBeLessThan(ledgerRecoveryIndex);
    expect(ledgerRecoveryIndex).toBeLessThan(startProcessIndex);
  });

  it('records and validates the app process identity instead of trusting a reusable PID', () => {
    expect(script).toContain('function Write-AppPidFile');
    expect(script).toContain('ConvertFrom-Json');
    expect(script).toContain('.StartTime');
    expect(script).toContain('ExpectedMainFile');
    expect(runtimeBlock).toContain('Write-AppPidFile');
    expect(runtimeBlock).not.toMatch(
      /Set-Content\s+-LiteralPath\s+\$pidFile\s+-Value\s+\$process\.Id/,
    );
    expect(stopScript).toContain('ConvertFrom-Json');
    expect(stopScript).toContain('ExpectedMainFile');
  });

  it('stops only the newly started Node when persisting app.pid fails', () => {
    const cleanupBlock = script.slice(
      script.indexOf('function Stop-NewlyStartedAppProcess'),
      script.indexOf('function Stop-PidFileProcess'),
    );

    expect(cleanupBlock).toContain('$ExpectedNodePath');
    expect(cleanupBlock).toContain('$ExpectedStartTimeUtc');
    expect(cleanupBlock).toContain("$current.ProcessName -cne 'node'");
    expect(cleanupBlock).toContain('Stop-Process -Id $current.Id -Force');
    expect(cleanupBlock).toContain('$current.WaitForExit(15000)');
    expect(runtimeBlock).toContain(
      '$processStartTimeUtc = $process.StartTime.ToUniversalTime()',
    );
    expect(runtimeBlock).toContain('Stop-NewlyStartedAppProcess');
    expect(runtimeBlock).toContain('$pidWriteAttempted = $true');
    expect(runtimeBlock).toContain(
      'Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop',
    );
    expect(runtimeBlock.indexOf('Stop-NewlyStartedAppProcess')).toBeGreaterThan(
      runtimeBlock.indexOf('Write-AppPidFile'),
    );
  });

  it('keeps stop-script port fallback scoped to the same app root', () => {
    const stopListenerBlock = stopScript.slice(
      stopScript.indexOf('function Stop-ListeningProcessesOnPort'),
      stopScript.indexOf('function Stop-AllScheduleNodeProcesses'),
    );

    expect(stopScript).toMatch(/param\(\s*\[int\]\$Port\s*=\s*0\s*\)/);
    expect(stopScript).toContain(
      "$envLocalFile = Join-Path $appRoot '.env.local'",
    );
    expect(stopScript).toMatch(
      /if \(\$Port -gt 0\)\s*\{\s*\$configuredPort = \$Port\s*\}/,
    );
    expect(stopListenerBlock).toContain('[string]$ExpectedRoot');
    expect(stopListenerBlock).toContain('[string]$ExpectedMainFile');
    expect(stopListenerBlock).toContain(
      'CommandLine.IndexOf($expectedRootPath',
    );
    expect(stopListenerBlock).toContain(
      'CommandLine.IndexOf($expectedMainPath',
    );
    expect(stopScript).toContain(
      'Stop-ListeningProcessesOnPort -Port $configuredPort -ExpectedRoot $appRoot -ExpectedMainFile $mainFile',
    );
  });

  it('does not trust a reusable numeric browser PID', () => {
    expect(browserBlock).not.toMatch(
      /Set-Content\s+-LiteralPath\s+\$browserPidFile/,
    );
    expect(stopPidBlock).not.toContain('$pidValue');
    expect(stopScript).toContain('CommandLine.Contains($browserProfile)');
  });

  it('stops the readiness wait as soon as the app process exits', () => {
    expect(readinessBlock).toContain('$Process.HasExited');
    expect(runtimeBlock).toMatch(
      /Wait-AppReady\s+-Url\s+\$readinessUrl\s+-NodePath\s+\$nodePath\s+-TimeoutSeconds\s+\$appReadinessTimeoutSeconds\s+-Process\s+\$process/,
    );
  });

  it.each(launchers)(
    '%s launcher allows slow Windows cold starts without masking a real process exit',
    (_label, launcher) => {
      const launcherReadinessBlock = launcher.slice(
        launcher.indexOf('function Get-AppReadinessTimeoutSeconds'),
        launcher.indexOf('function Open-AppBrowser'),
      );
      const launcherRuntimeBlock = launcher.slice(
        launcher.indexOf('$appRoot = Resolve-AppRoot'),
      );

      expect(launcherReadinessBlock).toContain(
        '$env:APP_STARTUP_TIMEOUT_SECONDS',
      );
      expect(launcherReadinessBlock).toContain('return 300');
      expect(launcherReadinessBlock).toContain('[int]$TimeoutSeconds = 300');
      expect(launcherReadinessBlock).toContain('$Process.HasExited');
      expect(launcherReadinessBlock).toContain(
        'runtime modules are loading...',
      );
      expect(launcherRuntimeBlock).toMatch(
        /Wait-AppReady\s+-Url\s+\$readinessUrl\s+-NodePath\s+\$nodePath\s+-TimeoutSeconds\s+\$appReadinessTimeoutSeconds\s+-Process\s+\$process/,
      );
    },
  );

  it('probes an IPv4 wildcard listener through the explicit IPv4 loopback', () => {
    expect(script).toContain('function Resolve-ReadinessHost');
    expect(script).toMatch(
      /if \(\$normalizedHost -eq '0\.0\.0\.0'\)\s*\{\s*return '127\.0\.0\.1'/,
    );
    expect(runtimeBlock).toContain(
      '$hostForUrl = Resolve-ReadinessHost -ConfiguredHost $configuredHost',
    );
  });

  it('prints filtered stdout and stderr diagnostics when readiness fails', () => {
    expect(script).toContain('function Write-AppStartupDiagnostics');
    expect(runtimeBlock).toMatch(
      /if \(!\(Wait-AppReady[\s\S]*?Write-AppStartupDiagnostics -StdoutPath \$stdout -StderrPath \$stderr/,
    );
    expect(script).toContain('Nest application successfully started');
    expect(script).toContain('Server running on');
  });

  it('flushes exited process logs and falls back to the stdout tail', () => {
    expect([
      ...runtimeBlock.matchAll(/\$process\.WaitForExit\(\)/g),
    ]).toHaveLength(2);
    expect([...runtimeBlock.matchAll(/\$process\.Refresh\(\)/g)]).toHaveLength(
      2,
    );
    expect(startupDiagnosticsBlock).toMatch(
      /if \(\$statusLines\.Count -eq 0\)[\s\S]*?Get-Content -LiteralPath \$StdoutPath -Tail \$TailLines/,
    );
  });
});
