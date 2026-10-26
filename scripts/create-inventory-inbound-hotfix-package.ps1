param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

throw (
  'UNSAFE_PARTIAL_HOTFIX_DISABLED: inventory inbound now crosses Nest module ' +
  'and runtime dependency boundaries. Use ' +
  'scripts/create-safe-full-runtime-hotfix-package.ps1 with -BaselineRoot.'
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "inventory-inbound-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_INVENTORY_INBOUND_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$verifierRelativePath = 'verify-client-asset-graph.mjs'
$verifierSourcePath = Join-Path $repoRoot 'scripts/verify-client-asset-graph.mjs'
$launcherRelativePath = 'start.ps1'
$launcherSourcePath = Join-Path $repoRoot 'deploy/start.ps1'

$runtimeRelativePaths = @(
  'dist/server/common/access/access-login-redaction.middleware.js',
  'dist/server/common/access/feishu-access.service.js',
  'dist/server/common/access/unified-access.controller.js',
  'dist/server/common/access/unified-access.decorators.js',
  'dist/server/common/access/unified-access.guard.js',
  'dist/server/common/access/unified-access.module.js',
  'dist/server/common/access/unified-access.service.js',
  'dist/server/common/feishu/bitable-direct-read.js',
  'dist/server/modules/bitable-sync/bitable-sync.module.js',
  'dist/server/modules/bitable-sync/today-operations-alarm.service.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.callback.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.card.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.gateway.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.rules.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.scheduler.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.service.js',
  'dist/server/modules/bitable-sync/today-operations-anomaly.store.js',
  'dist/server/modules/bitable-sync/today-operations-kpi.service.js',
  'dist/server/modules/bitable-sync/today-operations-overview.service.js',
  'dist/server/modules/duty-schedule/approved-leave-visibility.js',
  'dist/server/modules/duty-schedule/duty-program-modified-refresh.js',
  'dist/server/modules/duty-schedule/duty-staff-actual-field.js',
  'dist/server/modules/duty-schedule/long-white-duty-staff.js',
  'dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js',
  'dist/server/modules/inventory-management/inventory-access-policy.js',
  'dist/server/modules/inventory-management/inventory-inbound-catalog.rules.js',
  'dist/server/modules/inventory-management/inventory-inbound-task-ledger.store.js',
  'dist/server/modules/inventory-management/inventory-inbound-task.service.js',
  'dist/server/modules/inventory-management/inventory-management.controller.js',
  'dist/server/modules/inventory-management/inventory-management.mapper.js',
  'dist/server/modules/inventory-management/inventory-management.module.js',
  'dist/server/modules/inventory-management/inventory-management.query.js',
  'dist/server/modules/inventory-management/inventory-management.service.js',
  'dist/server/modules/inventory-management/inventory-movement-command.rules.js',
  'dist/server/modules/inventory-management/inventory-movement-command.service.js',
  'dist/server/modules/inventory-management/inventory-movement-deletion.service.js',
  'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js',
  'dist/server/modules/inventory-management/inventory-movement-operation-coordinator.js',
  'dist/server/modules/inventory-management/inventory-outbound-canonical.js',
  'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js',
  'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js',
  'dist/server/modules/inventory-management/inventory-storage-location.rules.js',
  'dist/server/modules/inventory-management/inventory-storage-location.service.js',
  'dist/server/modules/inventory-management/inventory-workflow.gateway.js',
  'dist/server/modules/inventory-management/inventory-workflow.rules.js',
  'dist/server/modules/inventory-management/inventory-workflow.scheduler.js',
  'dist/server/modules/inventory-management/inventory-workflow.service.js',
  'dist/server/modules/inventory-management/inventory-workflow.store.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js',
  'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js',
  'dist/server/modules/inventory-management/purchase-inbound-category-task.service.js',
  'dist/server/modules/purchase-inventory/feishu-card-action.consumer.js',
  'dist/server/modules/purchase-inventory/feishu-card-action.router.js',
  'dist/server/modules/purchase-inventory/purchase-access-policy.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-application-task-ledger.store.js',
  'dist/server/modules/purchase-inventory/purchase-code.rules.js',
  'dist/server/modules/purchase-inventory/purchase-code.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-online-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-record-deletion.service.js',
  'dist/server/modules/purchase-inventory/purchase-record-edit.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-card.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-session.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/shared/access-control.interface.js',
  'dist/shared/duty-staff-name.js',
  'dist/shared/inventory-management.interface.js',
  'dist/shared/today-operations-alarm.interface.js'
)

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
    [IO.Path]::DirectorySeparatorChar
  $childFullPath = [IO.Path]::GetFullPath($Child)
  if (
    !$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to use a path outside the output directory: $Child"
  }
}

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required compiled runtime file is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required compiled runtime directory is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function ConvertFrom-Utf8Base64 {
  param([string]$Value)

  return [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($Value)
  )
}

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -notmatch [regex]::Escape($marker)) {
      throw "Compiled runtime is missing marker '$marker': $RelativePath"
    }
  }
}

function Assert-ClientContainsMarker {
  param([string]$Marker)

  $matched = Get-ChildItem -LiteralPath (Join-Path $repoRoot $clientRelativePath) `
      -File `
      -Recurse |
    Select-String -SimpleMatch $Marker -Quiet
  if (!$matched) {
    throw "Compiled client is missing required inventory inbound marker."
  }
}

function Assert-InventoryRuntimeDependencyClosure {
  param(
    [string[]]$RuntimePaths,
    [string[]]$SourcePaths = $RuntimePaths,
    [string[]]$OwnedPrefixes = @(
      'dist/server/common/access/',
      'dist/server/modules/duty-schedule/',
      'dist/server/modules/inventory-management/',
      'dist/server/modules/purchase-inventory/',
      'dist/shared/'
    )
  )

  $runtimeSet = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($relativePath in $RuntimePaths) {
    [void]$runtimeSet.Add($relativePath.Replace('\', '/'))
  }

  $ownedFiles = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  [void]$ownedFiles.Add(
    'dist/server/common/feishu/bitable-direct-read.js'
  )
  foreach ($relativePath in $SourcePaths) {
    $normalizedPath = $relativePath.Replace('\', '/')
    $fullPath = Join-Path $repoRoot $relativePath
    if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Compiled runtime file was not found: $fullPath"
    }
    $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
    $matches = [regex]::Matches(
      $content,
      'require\(["'']((?:\.\.?/)[^"'']+)["'']\)'
    )
    foreach ($match in $matches) {
      $dependencyFullPath = [IO.Path]::GetFullPath(
        (Join-Path (Split-Path -Parent $fullPath) "$($match.Groups[1].Value).js")
      )
      $dependencyRelativePath = $dependencyFullPath.
        Substring($repoRoot.Length).
        TrimStart('\', '/').
        Replace('\', '/')
      $ownedDependency = $ownedFiles.Contains($dependencyRelativePath)
      if (!$ownedDependency) {
        foreach ($prefix in $OwnedPrefixes) {
          if ($dependencyRelativePath.StartsWith($prefix)) {
            $ownedDependency = $true
            break
          }
        }
      }
      if (
        $ownedDependency -and
        !$runtimeSet.Contains($dependencyRelativePath)
      ) {
        throw (
          "Scoped runtime dependency is missing from the allowlist: " +
          "$normalizedPath -> $dependencyRelativePath"
        )
      }
    }
  }
}

function Get-StageRelativePaths {
  param([string]$Stage)

  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($Stage.Length).
          TrimStart('\', '/').
          Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-StagedPayloadIsSafe {
  param([string]$Stage)

  $forbiddenDirectoryNames = @(
    '.git',
    'node_modules',
    'data',
    'logs',
    'certs',
    '.runtime',
    'output',
    'playwright'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.log',
    '.lock',
    '.pem',
    '.key',
    '.p12',
    '.pfx'
  )

  $unsafeItem = Get-ChildItem -LiteralPath $Stage -Force -Recurse |
    Where-Object {
      $name = $_.Name.ToLowerInvariant()
      if ($_.PSIsContainer) {
        return $name -in $forbiddenDirectoryNames
      }
      return (
        $name -eq '.env' -or
        $name.StartsWith('.env.') -or
        [IO.Path]::GetExtension($name) -in $forbiddenExtensions
      )
    } |
    Select-Object -First 1
  if ($unsafeItem) {
    throw "Refusing to package forbidden path: $($unsafeItem.FullName)"
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$RelativePaths
  )

  $files = @(
    $RelativePaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $fullPath).Length
        sha256 = (
          Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
        ).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    packageType = 'inventory-inbound-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    requiresRestart = $true
    secretsIncluded = $false
    dependencyInstallRequired = $false
    replaceRoots = @($clientRelativePath)
    replaceFiles = @($launcherRelativePath) + $runtimeRelativePaths
    preservePaths = @(
      '.env',
      '.env.local',
      'data',
      'logs',
      'certs',
      '.runtime',
      'node_modules'
    )
        scope = @(
          'manual-inbound-existing-or-new-item',
          'server-generated-inventory-sku',
          'purchase-inbound-target-building',
          'optimistic-inbound-backend-sync',
          'inventory-access-and-purchase-runtime-closure',
          'feishu-card-action-bitable-runtime-closure',
          'windows-powershell-native-stderr-capture'
        )
    files = $files
  } | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) `
      -Encoding UTF8
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; inventory inbound hotfix was not created.'
  }
}

$inboundLocationFieldName = ConvertFrom-Utf8Base64 '5YWl5bqT5a2Y5pS+5L2N572u'
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-inbound-catalog.rules.js' `
  -Markers @(
    'generateInventorySku',
    'buildInventoryCatalogFields',
    $inboundLocationFieldName
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-movement-command.rules.js' `
  -Markers @('validateMovementCreateRequest', 'clientMutationId')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-movement-command.service.js' `
  -Markers @(
    'createTrustedInbound',
    'prepareTrustedNewInboundCatalog',
    'ensureStrictInboundFields',
    'clientMutationId',
    $inboundLocationFieldName
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-management.mapper.js' `
  -Markers @(
    'getWarehouseInventoryLocationReadFieldNames',
    'resolveMovementLocation'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-workflow.gateway.js' `
  -Markers @('InventoryWorkflowRecordNotFoundError', 'ensureTextField', 'deletePersisted')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/feishu/bitable-direct-read.js' `
  -Markers @('invalidateBitableRecordCache', 'deletePersisted')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js' `
  -Markers @('validatePurchaseInboundConfirmation', 'needs_selection', 'clientMutationId')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js' `
  -Markers @('prepareCategory', 'createTrustedInbound', 'assertPurchaseInboundExecutionScope')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-management.controller.js' `
  -Markers @('createMovement', 'preparePurchaseInboundCategory', 'confirmPurchaseInbound')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-management.service.js' `
  -Markers @('invalidateCache')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/inventory-access-policy.js' `
  -Markers @('assertPurchaseInboundExecutionScope')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js' `
  -Markers @('PurchaseManagerApprovalService', 'sendInteractiveCard')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.module.js' `
  -Markers @(
    'providers:',
    'exports:',
    'today_operations_anomaly_service_1.TodayOperationsAnomalyService'
  )
Assert-CompiledFileContains `
  -RelativePath 'deploy/start.ps1' `
  -Markers @(
    'function Invoke-NativeCommandCaptured',
    "-Arguments @('run', 'migrate:overtime-workflow-fields:check')",
    "-Arguments @('run', 'migrate:leave-workflow-fields:check')"
  )
Assert-InventoryRuntimeDependencyClosure -RuntimePaths $runtimeRelativePaths
Assert-InventoryRuntimeDependencyClosure `
  -RuntimePaths $runtimeRelativePaths `
  -SourcePaths @(
    'dist/server/modules/bitable-sync/today-operations-alarm.service.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.callback.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.card.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.gateway.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.rules.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.scheduler.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.service.js',
    'dist/server/modules/bitable-sync/today-operations-anomaly.store.js',
    'dist/server/modules/bitable-sync/today-operations-kpi.service.js',
    'dist/server/modules/bitable-sync/today-operations-overview.service.js'
  ) `
  -OwnedPrefixes @(
    'dist/server/modules/bitable-sync/',
    'dist/server/modules/duty-schedule/',
    'dist/shared/'
  )

$clientRoot = Join-Path $repoRoot $clientRelativePath
if (!(Test-Path -LiteralPath (Join-Path $clientRoot 'index.html') -PathType Leaf)) {
  throw 'Compiled client index.html was not found.'
}
if (!(Test-Path -LiteralPath (Join-Path $clientRoot 'main.js') -PathType Leaf)) {
  throw 'Compiled client main.js was not found.'
}
if (@(Get-ChildItem -LiteralPath $clientRoot -File -Recurse).Count -lt 10) {
  throw 'Compiled client tree is unexpectedly incomplete.'
}
if (!(Test-Path -LiteralPath $verifierSourcePath -PathType Leaf)) {
  throw "Client asset graph verifier was not found: $verifierSourcePath"
}
& node $verifierSourcePath --root $clientRoot
if ($LASTEXITCODE -ne 0) {
  throw 'Compiled client asset graph is incomplete.'
}
Assert-ClientContainsMarker -Marker 'clientMutationId'
Assert-ClientContainsMarker -Marker (
  ConvertFrom-Utf8Base64 '5paw5aKe54mp5ZOB'
)
Assert-ClientContainsMarker -Marker (
  ConvertFrom-Utf8Base64 '5YWl5bqT5qW85qCL'
)
Assert-ClientContainsMarker -Marker (
  ConvertFrom-Utf8Base64 '55Sf5oiQ5paw55qE54mp5ZOB57G75Yir5Y+3'
)

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  Copy-RequiredDirectory `
    -Source $clientRoot `
    -Destination (Join-Path $stageDir $clientRelativePath)
  Copy-RequiredFile `
    -Source $verifierSourcePath `
    -Destination (Join-Path $stageDir $verifierRelativePath)
  Copy-RequiredFile `
    -Source (Join-Path $repoRoot 'deploy/start.ps1') `
    -Destination (Join-Path $stageDir 'start.ps1')
  foreach ($relativePath in $runtimeRelativePaths) {
    $nativeRelativePath = $relativePath.Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $nativeRelativePath) `
      -Destination (Join-Path $stageDir $nativeRelativePath)
  }

  $readme = @'
# Inventory inbound runtime hotfix

## Scope

- Adds existing/new item modes to manual inbound.
- Generates new inventory SKUs on the server and writes catalog, ledger and inbound records idempotently.
- Lets purchase inbound choose the destination building and warehouse location.
- Keeps immediate optimistic UI feedback while the backend remains the final source of truth.
- Stores writable warehouse text in `{{INBOUND_LOCATION_FIELD}}` and keeps read compatibility with the legacy select/reference location fields.

## Package contents

- `dist/client`: complete production client build. Replace this directory as one unit; do not mix old and new chunks.
- `dist/server/modules/inventory-management`: complete inventory runtime.
- `dist/server/modules/purchase-inventory`: purchase execution runtime required by purchase inbound confirmation.
- `dist/server/modules/bitable-sync/today-operations-*`: complete runtime closure required by the packaged Feishu card-action router.
- `dist/server/common/access` and `dist/shared/access-control.interface.js`: scoped inventory administrator identity and authorization runtime.
- `dist/server/common/feishu/bitable-direct-read.js`: persistent Feishu cache invalidation required after inventory writes.
- `dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js`: direct dependency of the packaged access guard.
- `dist/shared/inventory-management.interface.js`: shared runtime constants used by the backend.
- `start.ps1`: production launcher compatible with npm notices written to stderr on Windows PowerShell 5.1.
- `hotfix-manifest.json`: exact payload sizes and SHA-256 hashes.
- `verify-client-asset-graph.mjs`: validates that `main.js` and every lazy-loaded JS/CSS chunk belong to one complete build.

The package contains no environment files, credentials, certificates, logs, runtime data, test fixtures, source maps or TypeScript source. It does not install dependencies.
No earlier inventory inbound hotfix is required. The existing server build must already register `InventoryManagementModule` in `dist/server/app.module.js`; abort deployment if that marker is absent.

## Deployment

1. Verify the ZIP with the adjacent `.sha256.txt` file before extraction.
2. Stop the current application and back up the existing `dist/client` directory plus every runtime file listed in the manifest.
3. Replace `dist/client` as a complete directory, then overlay `start.ps1` plus the listed server and shared files at the application root.
4. Run `node verify-client-asset-graph.mjs --root dist/client` and stop deployment if it reports any missing asset.
5. Preserve the existing `.env`, `.env.local`, `node_modules`, `data`, `logs`, `certs` and `.runtime` paths.
6. Start the application with the existing production launcher and verify `/nantong-base`, the purchase page and the inbound page before allowing inbound operations.

A backend restart is required. No environment-variable change or dependency installation is required.
'@
  $readme = $readme.Replace(
    '{{INBOUND_LOCATION_FIELD}}',
    $inboundLocationFieldName
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readme `
    -Encoding UTF8

  & node (Join-Path $stageDir $verifierRelativePath) `
    --root (Join-Path $stageDir $clientRelativePath)
  if ($LASTEXITCODE -ne 0) {
    throw 'Staged client asset graph is incomplete.'
  }

  Assert-StagedPayloadIsSafe -Stage $stageDir
  $payloadRelativePaths = Get-StageRelativePaths -Stage $stageDir
  Write-HotfixManifest `
    -Stage $stageDir `
    -RelativePaths $payloadRelativePaths

  $actualFiles = Get-StageRelativePaths -Stage $stageDir
  $expectedFiles = @(
    $payloadRelativePaths + $manifestRelativePath | Sort-Object
  )
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }
  Assert-StagedPayloadIsSafe -Stage $stageDir

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archivePaths = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Sort-Object
    )
    if (
      $archivePaths.Count -ne $expectedFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
      @($expectedFiles | Where-Object { $_ -notin $archivePaths }).Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match the staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = (
    Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item `
        -LiteralPath $target `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Inventory inbound runtime hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
