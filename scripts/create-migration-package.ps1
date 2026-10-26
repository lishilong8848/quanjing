param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild,
  [switch]$IncludeEnv,
  [switch]$IncludeConstructionEnvPatch,
  [switch]$IncludeWarehouseInventoryEnvPatch,
  [switch]$IncludeDataCache,
  [switch]$IncludeCerts,
  [switch]$IncludeNodeRuntime,
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "nantong-schedule-$timestamp"
$outputRoot = Join-Path $repoRoot $OutputDir
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$overtimeWorkflowRuntimeCommands = [ordered]@{
  'self-test:overtime-workflow:dry-run' = 'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --dry-run'
  'self-test:overtime-workflow:apply-real' = 'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --apply-real'
  'self-test:overtime-workflow:audit' = 'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only'
  'self-test:overtime-workflow:cleanup' = 'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --cleanup-only'
}

function Copy-RequiredItem {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path $Source)) {
    throw "Required item not found: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Assert-NpmConfigurationSafeForPackaging {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if (
      $line -match '(?i)(?:^|:)\s*_(?:authToken|auth|password)\s*=' -or
      $line -match '(?i)^\s*(?:password|username)\s*=' -or
      $line -match '(?i)^\s*[^#;][^=]*=\s*[a-z][a-z0-9+.-]*://[^/\s@]+@'
    ) {
      throw 'Refusing to package .npmrc because it contains credential-bearing settings.'
    }
  }
}

function Remove-PreviousBuildOutput {
  param([string]$Root)

  $rootPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path).TrimEnd('\', '/')
  $rootPrefix = $rootPath + [IO.Path]::DirectorySeparatorChar
  $distPath = [IO.Path]::GetFullPath((Join-Path $rootPath 'dist'))
  if (!$distPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove build output outside the repository: $distPath"
  }
  if (!(Test-Path -LiteralPath $distPath -PathType Container)) {
    return
  }

  Write-Host "[INFO] Removing previous build output: $distPath"
  Remove-Item -LiteralPath $distPath -Recurse -Force
}

function Remove-ToolRuntimeArtifacts {
  param([string]$Path)

  if (!(Test-Path $Path)) {
    return
  }

  $runtimeNames = @(
    'config.json',
    'downloads',
    'temp',
    'logs',
    'run',
    'output',
    'build',
    'dist',
    'release',
    '__pycache__',
    '.pytest_cache'
  )

  foreach ($name in $runtimeNames) {
    $target = Join-Path $Path $name
    if (Test-Path $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }

  Get-ChildItem -LiteralPath $Path -Directory -Filter '__pycache__' -Recurse -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.pyc', '.pyo', '.log') } |
    Remove-Item -Force
}

function Copy-ToolDirectory {
  param(
    [string]$ToolName
  )

  $sourcePath = Join-Path (Join-Path $repoRoot 'tools') $ToolName
  if (!(Test-Path $sourcePath)) {
    return
  }

  $toolsStagePath = Join-Path $stageDir 'tools'
  New-Item -ItemType Directory -Force -Path $toolsStagePath | Out-Null
  $destinationPath = Join-Path $toolsStagePath $ToolName
  New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
  Get-ChildItem -LiteralPath $sourcePath -Force |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Recurse -Force
    }
  Remove-ToolRuntimeArtifacts -Path $destinationPath
}

function Copy-DirectoryFast {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path $Source)) {
    throw "Required directory not found: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    & $robocopy.Source $Source $Destination /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) {
      throw "robocopy failed with exit code $LASTEXITCODE while copying $Source"
    }
    return
  }

  Copy-Item -LiteralPath (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

function Get-NodeRuntimeRoot {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (!$node) {
    throw 'Cannot include Node runtime because node.exe was not found on this machine.'
  }
  return (Split-Path -Parent $node.Source)
}

function Get-FileSha256 {
  param([string]$Path)

  if (!(Test-Path $Path)) {
    return ''
  }

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Write-BundledDependencyStamp {
  param([string]$Root)

  $stamp = [ordered]@{
    packageJson = Get-FileSha256 -Path (Join-Path $Root 'package.json')
    packageLock = Get-FileSha256 -Path (Join-Path $Root 'package-lock.json')
    postinstallScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/postinstall.mjs')
    feishuCardPatchScript = Get-FileSha256 -Path (Join-Path $Root 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')
    installedAt = (Get-Date).ToString('s')
    bundled = $true
  }
  $stamp | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root '.deps-ready.json') -Encoding UTF8
}

function Set-OvertimeWorkflowPackageCommands {
  param([string]$PackagePath)

  $package = Get-Content -Raw -LiteralPath $PackagePath | ConvertFrom-Json
  foreach ($entry in $overtimeWorkflowRuntimeCommands.GetEnumerator()) {
    $property = $package.scripts.PSObject.Properties[$entry.Key]
    if (!$property) {
      throw "Overtime workflow package command is missing: $($entry.Key)"
    }
    $property.Value = $entry.Value
  }
  $packageJson = $package | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText(
    $PackagePath,
    $packageJson,
    [Text.UTF8Encoding]::new($false)
  )
}

function Assert-OvertimeWorkflowPackageContract {
  param([string]$Root)

  $requiredFiles = @(
    '.feishu-card-action-consumer-release',
    'scripts/ensure-overtime-workflow-fields.mjs',
    'scripts/self-test-overtime-workflow.mjs',
    'scripts/postinstall.mjs',
    'scripts/ensure-feishu-card-ws-sdk-patch.mjs',
    'dist/server/modules/purchase-inventory/feishu-card-action.consumer.js',
    'dist/server/modules/purchase-inventory/feishu-card-action.router.js',
    'dist/server/modules/overtime-workflow/overtime-workflow.card-action.consumer.js',
    'dist/server/modules/overtime-workflow/overtime-workflow.callback.js'
  )
  foreach ($relativePath in $requiredFiles) {
    if (!(Test-Path -LiteralPath (Join-Path $Root $relativePath) -PathType Leaf)) {
      throw "Overtime workflow package file is missing: $relativePath"
    }
  }

  $packagePath = Join-Path $Root 'package.json'
  $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
  $feishuSdkVersion = [string]$package.dependencies.'@larksuiteoapi/node-sdk'
  if ($feishuSdkVersion -ne '1.73.0') {
    throw "Feishu card callback SDK must be pinned to 1.73.0, got: $feishuSdkVersion"
  }
  $requiredCommands = @(
    'migrate:overtime-workflow-fields:check',
    'self-test:overtime-workflow:dry-run',
    'self-test:overtime-workflow:apply-real',
    'self-test:overtime-workflow:audit',
    'self-test:overtime-workflow:cleanup'
  )
  foreach ($command in $requiredCommands) {
    $property = $package.scripts.PSObject.Properties[$command]
    if (!$property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      throw "Overtime workflow package command is missing: $command"
    }
  }
  foreach ($entry in $overtimeWorkflowRuntimeCommands.GetEnumerator()) {
    $actual = [string]$package.scripts.PSObject.Properties[$entry.Key].Value
    if ($actual -ne $entry.Value) {
      throw "Overtime workflow package command must use bundled runtime assets: $($entry.Key)"
    }
  }
}

function Assert-LeaveWorkflowPackageContract {
  param([string]$Root)

  $requiredFiles = @(
    '.leave-workflow-program-release',
    'scripts/ensure-leave-workflow-fields.mjs',
    'scripts/self-test-leave-workflow.mjs',
    'dist/server/modules/leave-workflow/leave-workflow.service.js',
    'dist/server/modules/leave-workflow/leave-workflow.scheduler.js',
    'dist/server/modules/leave-workflow/leave-workflow.callback.js',
    'dist/server/modules/purchase-inventory/feishu-card-action.consumer.js',
    'dist/server/modules/purchase-inventory/feishu-card-action.router.js',
    'README_LEAVE_WORKFLOW.md'
  )
  foreach ($relativePath in $requiredFiles) {
    if (!(Test-Path -LiteralPath (Join-Path $Root $relativePath) -PathType Leaf)) {
      throw "Leave workflow package file is missing: $relativePath"
    }
  }

  $packagePath = Join-Path $Root 'package.json'
  $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
  $requiredCommands = @(
    'migrate:leave-workflow-fields:check',
    'self-test:leave-workflow',
    'self-test:leave-workflow:real',
    'self-test:leave-workflow:audit-cleanup'
  )
  foreach ($command in $requiredCommands) {
    $property = $package.scripts.PSObject.Properties[$command]
    if (!$property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      throw "Leave workflow package command is missing: $command"
    }
  }
}

function Read-DotEnvPairs {
  param([string]$Path)

  $result = @{}
  if (!(Test-Path $Path)) {
    return $result
  }

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -notmatch '^\s*[^#][^=]*=') {
      continue
    }

    $index = $line.IndexOf('=')
    if ($index -lt 1) {
      continue
    }

    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1)
    if ($key) {
      $result[$key] = $value
    }
  }

  return $result
}

function Write-ConstructionEnvPatchFromLocalEnv {
  param(
    [string]$EnvPath,
    [string]$Destination
  )

  $pairs = Read-DotEnvPairs -Path $EnvPath
  $keys = @(
    'FEISHU_CONSTRUCTION_OVERVIEW_SOURCE_URL',
    'FEISHU_CONSTRUCTION_FOLLOWUP_SOURCE_URL',
    'FEISHU_CONSTRUCTION_CREW_LEDGER_SOURCE_URL',
    'FEISHU_CONSTRUCTION_STAFF_SOURCE_URL',
    'FEISHU_CONSTRUCTION_CHANGE_ORDER_SOURCE_URL',
    'FEISHU_CONSTRUCTION_CHANGE_LINK_TABLE_ID',
    'FEISHU_CONSTRUCTION_MANAGEMENT_LISTEN_CHAT_ID',
    'FEISHU_CONSTRUCTION_CREW_ROSTER_NOTIFY_CHAT_ID',
    'CONSTRUCTION_CERTIFICATE_SERVICE_BASE_URL',
    'CONSTRUCTION_CERTIFICATE_SERVICE_START_SCRIPT',
    'CONSTRUCTION_CERTIFICATE_SERVICE_TIMEOUT_MS',
    'CONSTRUCTION_CERTIFICATE_SERVICE_PYTHON',
    'CHROME_BIN',
    'CHROMEDRIVER_PATH',
    'CONSTRUCTION_IMAGE_AUDIT_ENV_PATH',
    'CONSTRUCTION_IMAGE_AUDIT_BASE_URL',
    'CONSTRUCTION_IMAGE_AUDIT_MODEL',
    'CONSTRUCTION_IMAGE_AUDIT_TIMEOUT_MS',
    'CONSTRUCTION_IMAGE_AUDIT_RETRY_ATTEMPTS',
    'CONSTRUCTION_IMAGE_AUDIT_RETRY_BASE_DELAY_SECONDS'
  )

  $lines = New-Object System.Collections.Generic.List[string]
  [void]$lines.Add('# Private construction management env patch generated from local .env.')
  [void]$lines.Add('# This file intentionally excludes FEISHU_APP_SECRET and CONSTRUCTION_IMAGE_AUDIT_API_KEY.')
  foreach ($key in $keys) {
    if (!$pairs.ContainsKey($key)) {
      continue
    }
    $value = [string]$pairs[$key]
    if (!$value.Trim()) {
      continue
    }
    [void]$lines.Add("$key=$value")
  }

  if ($lines.Count -le 2) {
    Write-Host '[WARN] No construction management env values were found in local .env.' -ForegroundColor Yellow
    return
  }

  Set-Content -LiteralPath $Destination -Value $lines -Encoding UTF8
  Write-Host '[WARN] Private construction management env patch included. Keep this package private.' -ForegroundColor Yellow
}

function Write-WarehouseInventoryEnvPatch {
  param(
    [string]$EnvPath,
    [string]$Destination
  )

  $pairs = Read-DotEnvPairs -Path $EnvPath
  $keys = @(
    'FEISHU_WAREHOUSE_SOURCE_URL',
    'FEISHU_WAREHOUSE_APP_TOKEN',
    'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID',
    'FEISHU_WAREHOUSE_INBOUND_TABLE_ID',
    'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
    'FEISHU_WAREHOUSE_BORROW_TABLE_ID',
    'FEISHU_WAREHOUSE_CATALOG_TABLE_ID',
    'FEISHU_WAREHOUSE_PRICE_TABLE_ID',
    'FEISHU_WAREHOUSE_STOCKTAKE_SUMMARY_TABLE_ID',
    'FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
    'FEISHU_WAREHOUSE_PURCHASE_TABLE_ID',
    'FEISHU_WAREHOUSE_WORKFLOW_LOG_TABLE_ID'
  )

  $lines = New-Object System.Collections.Generic.List[string]
  [void]$lines.Add('# Private warehouse inventory env patch generated from local .env.')
  [void]$lines.Add('# This file intentionally excludes FEISHU_APP_SECRET.')
  foreach ($key in $keys) {
    if (!$pairs.ContainsKey($key)) {
      continue
    }
    $value = [string]$pairs[$key]
    if (!$value.Trim()) {
      continue
    }
    [void]$lines.Add("$key=$value")
  }

  if ($lines.Count -le 2) {
    Write-Host '[WARN] No warehouse inventory env values were found in local .env.' -ForegroundColor Yellow
    return
  }

  Set-Content -LiteralPath $Destination -Value $lines -Encoding UTF8
  Write-Host '[WARN] Private warehouse inventory env patch included. Keep this package private.' -ForegroundColor Yellow
}

Set-Location $repoRoot

if (!$SkipBuild) {
  Remove-PreviousBuildOutput -Root $repoRoot
  Write-Host '[INFO] Building production assets...'
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed.'
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path $stageDir) {
  throw "Stage directory already exists: $stageDir"
}
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

Write-Host "[INFO] Staging package: $stageDir"
Set-Content `
  -LiteralPath (Join-Path $stageDir '.feishu-card-action-consumer-release') `
  -Value 'FEISHU_CARD_ACTION_CONSUMER_RELEASE_V1' `
  -Encoding ASCII
Set-Content `
  -LiteralPath (Join-Path $stageDir '.leave-workflow-program-release') `
  -Value 'LEAVE_WORKFLOW_PROGRAM_RELEASE_V1' `
  -Encoding ASCII
$distStagePath = Join-Path $stageDir 'dist'
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist') -Destination $distStagePath
$sourceMapsStagePath = Join-Path $distStagePath 'sourcemaps'
if (Test-Path -LiteralPath $sourceMapsStagePath -PathType Container) {
  Write-Host '[INFO] Excluding source maps from the runnable package.'
  Remove-Item -LiteralPath $sourceMapsStagePath -Recurse -Force
}
Get-ChildItem -LiteralPath $distStagePath -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.log' } |
  Remove-Item -Force
Copy-RequiredItem -Source (Join-Path $repoRoot 'package.json') -Destination (Join-Path $stageDir 'package.json')
Copy-RequiredItem -Source (Join-Path $repoRoot 'package-lock.json') -Destination (Join-Path $stageDir 'package-lock.json')
Set-OvertimeWorkflowPackageCommands -PackagePath (Join-Path $stageDir 'package.json')
Copy-RequiredItem -Source (Join-Path $repoRoot '.env.example') -Destination (Join-Path $stageDir '.env.example')
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'scripts') | Out-Null
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/postinstall.mjs') -Destination (Join-Path $stageDir 'scripts/postinstall.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-feishu-card-ws-sdk-patch.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-feishu-card-ws-sdk-patch.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/run-with-env.mjs') -Destination (Join-Path $stageDir 'scripts/run-with-env.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-overtime-workflow-fields.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-overtime-workflow-fields.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/self-test-overtime-workflow.mjs') -Destination (Join-Path $stageDir 'scripts/self-test-overtime-workflow.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-leave-workflow-fields.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-leave-workflow-fields.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/self-test-leave-workflow.mjs') -Destination (Join-Path $stageDir 'scripts/self-test-leave-workflow.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-inventory-outbound-approval-fields.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-inventory-outbound-approval-fields.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/ensure-purchase-inventory-config.mjs') -Destination (Join-Path $stageDir 'scripts/ensure-purchase-inventory-config.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/verify-contract-storage-startup.mjs') -Destination (Join-Path $stageDir 'scripts/verify-contract-storage-startup.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/start-construction-certificate-service.ps1') -Destination (Join-Path $stageDir 'scripts/start-construction-certificate-service.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/install-ali-monthly-report-python-deps.ps1') -Destination (Join-Path $stageDir 'scripts/install-ali-monthly-report-python-deps.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/apply-ali-monthly-report-email-env.ps1') -Destination (Join-Path $stageDir 'scripts/apply-ali-monthly-report-email-env.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/render-contract-pdf.py') -Destination (Join-Path $stageDir 'scripts/render-contract-pdf.py')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/requirements-contract-preview.txt') -Destination (Join-Path $stageDir 'scripts/requirements-contract-preview.txt')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/install-contract-preview-python-deps.ps1') -Destination (Join-Path $stageDir 'scripts/install-contract-preview-python-deps.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/remove-legacy-contract-ocr.ps1') -Destination (Join-Path $stageDir 'scripts/remove-legacy-contract-ocr.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-unified-access.mjs') -Destination (Join-Path $stageDir 'scripts/configure-unified-access.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-unified-access.ps1') -Destination (Join-Path $stageDir 'scripts/configure-unified-access.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-purchase-access.mjs') -Destination (Join-Path $stageDir 'scripts/configure-purchase-access.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-purchase-access.ps1') -Destination (Join-Path $stageDir 'scripts/configure-purchase-access.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-inventory-access.mjs') -Destination (Join-Path $stageDir 'scripts/configure-inventory-access.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-inventory-access.ps1') -Destination (Join-Path $stageDir 'scripts/configure-inventory-access.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-construction-access.mjs') -Destination (Join-Path $stageDir 'scripts/configure-construction-access.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-construction-access.ps1') -Destination (Join-Path $stageDir 'scripts/configure-construction-access.ps1')

& (Join-Path $stageDir 'scripts/remove-legacy-contract-ocr.ps1') -Root $stageDir

$certificateServicePath = Join-Path $repoRoot 'tools/construction-certificate-service'
if (Test-Path $certificateServicePath) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'tools') | Out-Null
  Copy-RequiredItem -Source $certificateServicePath -Destination (Join-Path (Join-Path $stageDir 'tools') 'construction-certificate-service')
  Get-ChildItem -LiteralPath (Join-Path (Join-Path $stageDir 'tools') 'construction-certificate-service') -Directory -Filter '__pycache__' -Recurse |
    Remove-Item -Recurse -Force
}

Copy-ToolDirectory -ToolName 'ali-monthly-report'
Copy-ToolDirectory -ToolName 'ali-monthly-report-email'

if (Test-Path (Join-Path $repoRoot '.npmrc')) {
  Assert-NpmConfigurationSafeForPackaging -Path (Join-Path $repoRoot '.npmrc')
  Copy-Item -LiteralPath (Join-Path $repoRoot '.npmrc') -Destination (Join-Path $stageDir '.npmrc') -Force
}

$hasBundledNodeRuntime = $false
if ($IncludeNodeRuntime) {
  $nodeRuntimeRoot = Get-NodeRuntimeRoot
  $nodeRuntimeDestination = Join-Path (Join-Path $stageDir '.runtime') 'node'
  Write-Host "[INFO] Including Node.js runtime: $nodeRuntimeRoot"
  Copy-DirectoryFast -Source $nodeRuntimeRoot -Destination $nodeRuntimeDestination
  $hasBundledNodeRuntime = $true
}

if ($IncludeNodeModules) {
  $nodeModulesRoot = Join-Path $repoRoot 'node_modules'
  Write-Host "[INFO] Including node_modules. This may take a while..."
  Copy-DirectoryFast -Source $nodeModulesRoot -Destination (Join-Path $stageDir 'node_modules')
  Write-BundledDependencyStamp -Root $stageDir
}

$certsPath = Join-Path $repoRoot 'certs'
if ($IncludeCerts -and (Test-Path $certsPath)) {
  Copy-Item -LiteralPath $certsPath -Destination (Join-Path $stageDir 'certs') -Recurse -Force
  Write-Host '[WARN] TLS certificates have been included. Keep this package private.' -ForegroundColor Yellow
}

Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/start.ps1') -Destination (Join-Path $stageDir 'start.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/stop.ps1') -Destination (Join-Path $stageDir 'stop.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/watchdog.ps1') -Destination (Join-Path $stageDir 'watchdog.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/install-autostart.ps1') -Destination (Join-Path $stageDir 'install-autostart.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/uninstall-autostart.ps1') -Destination (Join-Path $stageDir 'uninstall-autostart.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/start.cmd') -Destination (Join-Path $stageDir 'start.cmd')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/stop.cmd') -Destination (Join-Path $stageDir 'stop.cmd')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/README.md') -Destination (Join-Path $stageDir 'README_DEPLOY.md')
Copy-RequiredItem -Source (Join-Path $repoRoot 'docs/runbooks/overtime-program-workflow.md') -Destination (Join-Path $stageDir 'README_OVERTIME_WORKFLOW.md')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/README_LEAVE_WORKFLOW.md') -Destination (Join-Path $stageDir 'README_LEAVE_WORKFLOW.md')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/README_PURCHASE_APPROVAL_HOTFIX.md') -Destination (Join-Path $stageDir 'README_PURCHASE_APPROVAL_HOTFIX.md')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/README_OCR_CLEANUP.md') -Destination (Join-Path $stageDir 'README_OCR_CLEANUP.md')
$supplyChainCacheReadme = Join-Path $repoRoot 'deploy/README_SUPPLY_CHAIN_CACHE.md'
if (Test-Path $supplyChainCacheReadme) {
  Copy-Item -LiteralPath $supplyChainCacheReadme -Destination (Join-Path $stageDir 'README_SUPPLY_CHAIN_CACHE.md') -Force
}

$todayFocusEnvPatch = Join-Path $repoRoot 'deploy/today-focus-env.patch.example'
if (Test-Path $todayFocusEnvPatch) {
  Copy-Item -LiteralPath $todayFocusEnvPatch -Destination (Join-Path $stageDir 'today-focus-env.patch.example') -Force
}

$todayFocusEnvMergePs1 = Join-Path $repoRoot 'deploy/apply-today-focus-env.ps1'
if (Test-Path $todayFocusEnvMergePs1) {
  Copy-Item -LiteralPath $todayFocusEnvMergePs1 -Destination (Join-Path $stageDir 'apply-today-focus-env.ps1') -Force
}

$todayFocusEnvMergeCmd = Join-Path $repoRoot 'deploy/apply-today-focus-env.cmd'
if (Test-Path $todayFocusEnvMergeCmd) {
  Copy-Item -LiteralPath $todayFocusEnvMergeCmd -Destination (Join-Path $stageDir 'apply-today-focus-env.cmd') -Force
}

$todayFocusReadme = Join-Path $repoRoot 'deploy/README_TODAY_FOCUS.md'
if (Test-Path $todayFocusReadme) {
  Copy-Item -LiteralPath $todayFocusReadme -Destination (Join-Path $stageDir 'README_TODAY_FOCUS.md') -Force
}

$constructionEnvPatch = Join-Path $repoRoot 'deploy/construction-management-env.patch.example'
if (Test-Path $constructionEnvPatch) {
  Copy-Item -LiteralPath $constructionEnvPatch -Destination (Join-Path $stageDir 'construction-management-env.patch.example') -Force
}

$constructionEnvMergePs1 = Join-Path $repoRoot 'deploy/apply-construction-management-env.ps1'
if (Test-Path $constructionEnvMergePs1) {
  Copy-Item -LiteralPath $constructionEnvMergePs1 -Destination (Join-Path $stageDir 'apply-construction-management-env.ps1') -Force
}

$constructionEnvMergeCmd = Join-Path $repoRoot 'deploy/apply-construction-management-env.cmd'
if (Test-Path $constructionEnvMergeCmd) {
  Copy-Item -LiteralPath $constructionEnvMergeCmd -Destination (Join-Path $stageDir 'apply-construction-management-env.cmd') -Force
}

$constructionReadme = Join-Path $repoRoot 'deploy/README_CONSTRUCTION_MANAGEMENT.md'
if (Test-Path $constructionReadme) {
  Copy-Item -LiteralPath $constructionReadme -Destination (Join-Path $stageDir 'README_CONSTRUCTION_MANAGEMENT.md') -Force
}

if ($IncludeConstructionEnvPatch) {
  Write-ConstructionEnvPatchFromLocalEnv `
    -EnvPath (Join-Path $repoRoot '.env') `
    -Destination (Join-Path $stageDir 'construction-management-env.patch.local')
}

$warehouseInventoryEnvPatch = Join-Path $repoRoot 'deploy/warehouse-inventory-env.patch.example'
if (Test-Path $warehouseInventoryEnvPatch) {
  Copy-Item -LiteralPath $warehouseInventoryEnvPatch -Destination (Join-Path $stageDir 'warehouse-inventory-env.patch.example') -Force
}

$warehouseInventoryEnvMergePs1 = Join-Path $repoRoot 'deploy/apply-warehouse-inventory-env.ps1'
if (Test-Path $warehouseInventoryEnvMergePs1) {
  Copy-Item -LiteralPath $warehouseInventoryEnvMergePs1 -Destination (Join-Path $stageDir 'apply-warehouse-inventory-env.ps1') -Force
}

$warehouseInventoryEnvMergeCmd = Join-Path $repoRoot 'deploy/apply-warehouse-inventory-env.cmd'
if (Test-Path $warehouseInventoryEnvMergeCmd) {
  Copy-Item -LiteralPath $warehouseInventoryEnvMergeCmd -Destination (Join-Path $stageDir 'apply-warehouse-inventory-env.cmd') -Force
}

$warehouseInventoryReadme = Join-Path $repoRoot 'deploy/README_WAREHOUSE_INVENTORY.md'
if (Test-Path $warehouseInventoryReadme) {
  Copy-Item -LiteralPath $warehouseInventoryReadme -Destination (Join-Path $stageDir 'README_WAREHOUSE_INVENTORY.md') -Force
}

if ($IncludeWarehouseInventoryEnvPatch) {
  Write-WarehouseInventoryEnvPatch `
    -EnvPath (Join-Path $repoRoot '.env') `
    -Destination (Join-Path $stageDir 'warehouse-inventory-env.patch.local')
}

$sslEnvPs1 = Join-Path $repoRoot 'deploy/apply-ssl-env.ps1'
if (Test-Path $sslEnvPs1) {
  Copy-Item -LiteralPath $sslEnvPs1 -Destination (Join-Path $stageDir 'apply-ssl-env.ps1') -Force
}

$sslEnvCmd = Join-Path $repoRoot 'deploy/apply-ssl-env.cmd'
if (Test-Path $sslEnvCmd) {
  Copy-Item -LiteralPath $sslEnvCmd -Destination (Join-Path $stageDir 'apply-ssl-env.cmd') -Force
}

$sslReadme = Join-Path $repoRoot 'deploy/README_SSL.md'
if (Test-Path $sslReadme) {
  Copy-Item -LiteralPath $sslReadme -Destination (Join-Path $stageDir 'README_SSL.md') -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'logs') | Out-Null

if ($IncludeDataCache) {
  $dataPath = Join-Path $repoRoot 'data'
  if (Test-Path $dataPath) {
    Copy-Item -LiteralPath $dataPath -Destination (Join-Path $stageDir 'data') -Recurse -Force
  }
}

if ($IncludeEnv) {
  $envPath = Join-Path $repoRoot '.env'
  if (Test-Path $envPath) {
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $stageDir '.env') -Force
    Write-Host '[WARN] .env has been included. Keep this package private.' -ForegroundColor Yellow
  } else {
    Write-Host '[WARN] -IncludeEnv was set, but .env was not found.' -ForegroundColor Yellow
  }
}

Assert-OvertimeWorkflowPackageContract -Root $stageDir
Assert-LeaveWorkflowPackageContract -Root $stageDir

Write-Host "[INFO] Creating zip: $zipPath"
for ($attempt = 1; $attempt -le 5; $attempt += 1) {
  try {
    if (Test-Path $zipPath) {
      Remove-Item -LiteralPath $zipPath -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $stageDir,
      $zipPath,
      [System.IO.Compression.CompressionLevel]::Fastest,
      $false
    )
    break
  } catch {
    if ($attempt -ge 5) {
      throw
    }
    Write-Host "[WARN] Zip creation failed, retrying in $attempt second(s): $($_.Exception.Message)" -ForegroundColor Yellow
    Start-Sleep -Seconds $attempt
  }
}

Write-Host '[OK] Migration package created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
