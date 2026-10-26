param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-certificate-dashboard-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_PURCHASE_CERTIFICATE_DASHBOARD_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$basePackageName = 'nantong-schedule-20260717-205446'

$serverRelativePaths = @(
  'dist/server/common/feishu/bitable-direct-read.js',
  'dist/server/modules/bitable-sync/bitable-sync.controller.js',
  'dist/server/modules/bitable-sync/bitable-sync.module.js',
  'dist/server/modules/bitable-sync/certificate-dashboard.mapper.js',
  'dist/server/modules/bitable-sync/certificate-dashboard.service.js',
  'dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-record-edit.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-card.js',
  'dist/server/modules/inventory-management/inventory-management.module.js',
  'dist/server/modules/inventory-management/inventory-workflow.gateway.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
  'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'
)

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

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
  param(
    [string]$Source,
    [string]$Destination
  )

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
  param(
    [string]$Source,
    [string]$Destination
  )

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
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -notmatch [regex]::Escape($marker)) {
      throw "Compiled runtime is missing required behavior marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $searchableFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Recurse |
      Where-Object { $_.Extension -in @('.js', '.html') }
  )
  foreach ($marker in $Markers) {
    if (!($searchableFiles | Select-String -SimpleMatch -Pattern $marker -Quiet)) {
      throw "Compiled client is missing required behavior marker '$marker'."
    }
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
        sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    files = $files
  } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

Assert-CompiledClientContains -Markers @(
  'campus-certificate-dashboard/notify-expiring',
  'certificate-expiry-day-detail-dialog',
  'data-purchase-execution-id',
  '/api/inventory-management/purchase-inbounds/confirm'
)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/bitable-sync.controller.js' `
  -Markers @('campus-certificate-dashboard/notify-expiring')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js' `
  -Markers @('sendSelfTestSuccess')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.service.js' `
  -Markers @('enqueueCompletionNotifications')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js' `
  -Markers @('notificationWarnings')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-record-edit.service.js' `
  -Markers @('updateRecord')

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
    -Source (Join-Path $repoRoot $clientRelativePath) `
    -Destination (Join-Path $stageDir $clientRelativePath)
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Purchase and campus certificate dashboard minimal hotfix',
    '',
    '## Required baseline',
    '',
    "Apply this hotfix only to $basePackageName or an equivalent deployed version.",
    'Do not apply it directly to an older installation.',
    '',
    '## Scope',
    '',
    '- Replaces one complete production build of dist/client for the purchase page, purchase inbound flow, and campus certificate dashboard.',
    '- Replaces only the changed purchase application, approval workflow, record edit, inbound confirmation, and completion notification server files.',
    '- Replaces only the changed certificate data, detail dialog, update time, and expiry notification server files.',
    '- dist/client is the smallest safe frontend unit because its entry and asynchronous chunks use content hashes.',
    '',
    '## Deployment',
    '',
    '1. Verify the ZIP SHA256 against the matching .sha256.txt sidecar.',
    '2. If the watchdog is installed, create .maintenance.lock in the application root.',
    '3. Back up every matching path listed in hotfix-manifest.json. Back up dist/client as one complete directory.',
    '4. Stop the service with the existing stop.cmd.',
    '5. Extract the ZIP into the existing application root and overwrite matching paths. Do not add another top-level directory or mix old and new dist/client files.',
    '6. Start the service with the existing start.cmd. Remove .maintenance.lock only after the service is healthy.',
    '7. Press Ctrl+F5 and verify the purchase page, purchase inbound flow, certificate date and metric dialogs, and notification preview.',
    '',
    '## Rollback',
    '',
    'Stop the service, restore the complete dist/client backup and every backend file listed in the manifest, then restart.',
    '',
    '## Exclusions',
    '',
    'This package contains no .env files, Feishu secrets, certificates, data, logs, node_modules, sourcemaps, source files, tests, dependency manifests, or service scripts.',
    'It does not overwrite existing environment variables. Certificate synchronization and Feishu notifications continue to use the server configuration.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $manifestPayloadPaths = @(
    Get-StageRelativePaths -Stage $stageDir
  )
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

  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
      $_ -match '\.(map|ts|tsx|spec|log|pem|key)$'
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
        $_.StartsWith('/') -or
        $_ -match '(^|/)\.\.(/|$)'
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
  if (Test-Path -LiteralPath $stageDir) {
    Assert-ChildPath -Parent $outputRoot -Child $stageDir
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $zipPath) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $sidecarPath) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[OK] Purchase and certificate dashboard minimal hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
