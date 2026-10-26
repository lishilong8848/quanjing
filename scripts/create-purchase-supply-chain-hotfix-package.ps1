param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-supply-chain-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_PURCHASE_SUPPLY_CHAIN_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'

$serverRelativePaths = @(
  'dist/server/common/access/unified-access.guard.js',
  'dist/server/common/feishu/bitable-direct-read.js',
  'dist/server/modules/bitable-sync/bitable-sync.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.service.js',
  'dist/server/modules/purchase-inventory/purchase-online-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-access-policy.service.js',
  'dist/server/modules/purchase-inventory/purchase-record-edit.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-session.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/contract-management/contract-management.service.js',
  'dist/server/modules/inventory-management/inventory-management.service.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js',
  'dist/shared/purchase-inventory.interface.js'
)

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)

  $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
    [IO.Path]::DirectorySeparatorChar
  $childFullPath = [IO.Path]::GetFullPath($Child)
  if (!$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Copy-RequiredFile {
  param([string]$Source, [string]$Destination)

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required hotfix payload is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory {
  param([string]$Source, [string]$Destination)

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required hotfix payload directory is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Get-StageRelativePaths {
  param([string]$Stage)

  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-CompiledFileContains {
  param([string]$RelativePath, [string[]]$Markers)

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -notmatch [regex]::Escape($marker)) {
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileExcludes {
  param([string]$RelativePath, [string[]]$Markers)

  $fullPath = Join-Path $repoRoot $RelativePath
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -match [regex]::Escape($marker)) {
      throw "Compiled runtime still contains retired marker '$marker': $RelativePath"
    }
  }
}

function ConvertFrom-Utf8Base64 {
  param([string]$Value)

  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Write-HotfixManifest {
  param([string]$Stage, [string[]]$RelativePaths)

  $files = @(
    $RelativePaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      [ordered]@{
        path = $_
        sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = $packageName
    purpose = 'Fix approval and status writes, execution-table purchase creation, specification columns and four-hour supply-chain synchronization'
    requiresRestart = $true
    files = $files
  } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

$applicationFieldsPath = 'dist/server/modules/purchase-inventory/purchase-application.validation.js'
$workflowFieldName = ConvertFrom-Utf8Base64 '6YeH6LSt5rWB56iL'
$specificationFieldName = ConvertFrom-Utf8Base64 '54mp5ZOB6KeE5qC85Z6L5Y+344CB6K6+5aSH5bqP5YiX5Y+3'
$positiveOrderQuantityMessage = ConvertFrom-Utf8Base64 '5a6e6ZmF6YeH6LSt5pWw6YeP5b+F6aG75aSn5LqOIDA='
$orderedAtFieldName = ConvertFrom-Utf8Base64 '5LiL5Y2V5pe26Ze0'
$awaitingReceiptStatus = ConvertFrom-Utf8Base64 '5LiL5Y2V5a6M5oiQ77yI5b6F562+5pS277yJ'
$awaitingInboundStatus = ConvertFrom-Utf8Base64 '5Yiw6LSn5bey562+5pS277yI5b6F5YWl5bqT77yJ'
$completedInboundStatus = ConvertFrom-Utf8Base64 '6YeH6LSt5a6M5oiQ77yI5bey5YWl5bqT77yJ'
$retiredApprovalFieldNames = @(
  ConvertFrom-Utf8Base64 'Mu+4j+KDo+WuoeaJueW3suWujOaIkO+8iOaXoOmcgOeCueWHu++8iQ=='
  ConvertFrom-Utf8Base64 'Mu+4j+KDo+WuoeaJuemAmui/h++8iOaXoOmcgOeCueWHu++8iQ=='
  ConvertFrom-Utf8Base64 'Mu+4j+KDo+WuoeaJuemps+Wbnu+8iOaXoOmcgOeCueWHu++8iQ=='
)
Assert-CompiledFileContains `
  -RelativePath $applicationFieldsPath `
  -Markers @($workflowFieldName, $specificationFieldName)
Assert-CompiledFileExcludes `
  -RelativePath $applicationFieldsPath `
  -Markers $retiredApprovalFieldNames
$approvalWritePaths = @(
  'dist/server/modules/purchase-inventory/purchase-online-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-record-edit.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js'
)
foreach ($approvalWritePath in $approvalWritePaths) {
  Assert-CompiledFileExcludes `
    -RelativePath $approvalWritePath `
    -Markers $retiredApprovalFieldNames
}
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow-session.js' `
  -Markers @('purchase_applicant', 'purchaseBuilding')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.rules.js' `
  -Markers @(
    $positiveOrderQuantityMessage,
    $orderedAtFieldName,
    $awaitingReceiptStatus,
    $awaitingInboundStatus
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.store.js' `
  -Markers @(
    'PURCHASE_WORKFLOW_STALE_LOCK_CLEANUP_FAILED',
    'startup will continue'
  )
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js' `
  -Markers @($awaitingInboundStatus, $completedInboundStatus)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-access-policy.service.js' `
  -Markers @('editor', 'stocked')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/access/unified-access.guard.js' `
  -Markers @('isPurchaseRecordDeleteAdminOnlyException')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/feishu/bitable-direct-read.js' `
  -Markers @('FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS', '4 * 60 * 60 * 1000')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.service.js' `
  -Markers @('FEISHU_LOCAL_CACHE_REFRESH_MS', '4 * 60 * 60 * 1000')
foreach ($dashboardService in @(
    'dist/server/modules/purchase-inventory/purchase-inventory.service.js',
    'dist/server/modules/contract-management/contract-management.service.js',
    'dist/server/modules/inventory-management/inventory-management.service.js'
  )) {
  Assert-CompiledFileContains `
    -RelativePath $dashboardService `
    -Markers @('4 * 60 * 60 * 1000')
}

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
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Purchase and supply-chain four-hour synchronization hotfix',
    '',
    '## Fix scope',
    '',
    '- Creates new purchase requests only in the purchase execution table.',
    '- Removes retired approval checkbox writes from approvals, card tasks and record status edits.',
    '- Uses the purchase workflow field as the approval source of truth and keeps background retries idempotent.',
    '- Adds specification to application, execution and completion lists.',
    '- Requires new purchase quantities to be positive integers.',
    '- Refreshes purchase, contract, inventory and backend snapshots every four hours by default.',
        '- Lets administrators and purchase administrators submit orders; same-building applicants can submit only building self-purchases.',
        '- Moves submitted orders immediately to waiting for receipt and rolls the page back if Feishu synchronization fails.',
        '- Continues startup after a stale workflow ledger lock is isolated even if its quarantine file cannot be deleted immediately.',
    '',
    '## Deployment',
    '',
    '1. Stop the application and back up dist/client plus every server file listed in hotfix-manifest.json.',
    '2. Remove or move the old dist/client directory so old hashed chunks cannot remain.',
    '3. Extract this ZIP into the application root and overwrite matching paths.',
    '4. If the server .env already defines these keys, set all three to 14400000:',
    '   - FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS',
    '   - FEISHU_LOCAL_CACHE_TTL_MS',
    '   - FEISHU_LOCAL_CACHE_REFRESH_MS',
    '5. Restart the application and press Ctrl+F5 in the browser.',
    '6. Submit one controlled request; it must appear only in the execution table.',
    '',
    'If these keys are absent, no .env edit is needed; the compiled default is already four hours.',
    '',
    '## Rollback',
    '',
    'Stop the application, restore the backed-up client directory and server files, then restart.',
    '',
    'This package excludes .env files, secrets, certificates, node_modules, logs, business data, sources, tests and sourcemaps.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $manifestPayloadPaths = @(Get-StageRelativePaths -Stage $stageDir)
  Write-HotfixManifest -Stage $stageDir -RelativePaths $manifestPayloadPaths

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @(
    $manifestPayloadPaths
    $manifestRelativePath
  ) | Sort-Object
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $forbiddenFileNames = @('package.json', 'package-lock.json')
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.key',
    '.pfx',
    '.p12'
  )
  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $leafName = [IO.Path]::GetFileName($_)
      $extension = [IO.Path]::GetExtension($_)
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
      $leafName -in $forbiddenFileNames -or
      $extension -in $forbiddenExtensions
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }

  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Refusing to package a reparse point: $($reparsePoints[0].FullName)"
  }

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
      $archivePaths.Count -ne $actualFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $actualFiles }).Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match the staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Purchase supply-chain hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
