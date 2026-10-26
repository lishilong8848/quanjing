param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-dashboard-server-sync-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$serverModuleRelativePath = 'dist/server/modules/purchase-inventory'
$readmeRelativePath = 'README_PURCHASE_DASHBOARD_SERVER_SYNC_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$runtimeRelativePaths = @(
  'dist/server/common/feishu/bitable-direct-read.js',
  'dist/shared/access-control.interface.js',
  'dist/shared/purchase-application.interface.js',
  'dist/shared/purchase-inventory.interface.js',
  'dist/shared/purchase-workflow.interface.js'
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
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileExcludes {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -match [regex]::Escape($marker)) {
      throw "Compiled runtime still contains retired marker '$marker': $RelativePath"
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
    package = $packageName
    purpose = 'Synchronize the public purchase backend with the execution-table-only local dashboard runtime'
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
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Server build failed; hotfix package was not created.'
  }
}

$dashboardServicePath = "$serverModuleRelativePath/purchase-inventory.service.js"
Assert-CompiledFileContains `
  -RelativePath $dashboardServicePath `
  -Markers @('submissions: sourceSections.executions', 'submissions: []')
Assert-CompiledFileExcludes `
  -RelativePath $dashboardServicePath `
  -Markers @('FEISHU_PURCHASE_SUBMISSION_TABLE_ID')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/common/feishu/bitable-direct-read.js' `
  -Markers @('createBitableBackgroundRefresh')
Assert-CompiledFileContains `
  -RelativePath "$serverModuleRelativePath/purchase-inventory.mapper.js" `
  -Markers @('workflowStatus', 'stageCounts.approval', 'pendingInbound')
Assert-CompiledFileContains `
  -RelativePath "$serverModuleRelativePath/purchase-workflow-receipt-task.service.js" `
  -Markers @('signerOpenId', 'receiptPhoto')

$serverModuleRoot = Join-Path $repoRoot $serverModuleRelativePath
$moduleFiles = @(
  Get-ChildItem -LiteralPath $serverModuleRoot -Filter '*.js' -File |
    Sort-Object Name
)
if ($moduleFiles.Count -lt 20) {
  throw 'Compiled purchase server module is unexpectedly incomplete.'
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

  foreach ($moduleFile in $moduleFiles) {
    $relativePath = "$serverModuleRelativePath/$($moduleFile.Name)"
    Copy-RequiredFile `
      -Source $moduleFile.FullName `
      -Destination (Join-Path $stageDir $relativePath)
  }
  foreach ($relativePath in $runtimeRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Purchase Dashboard Server Sync Hotfix',
    '',
    '## Fix scope',
    '',
    '- Synchronizes the public purchase dashboard backend with the local runtime.',
    '- Application, execution and stage summaries read the execution Bitable only.',
    '- Stops merging legacy submission-table rows into the dashboard.',
    '- Keeps manual receipt signer selection, optional invoices, approvals and background synchronization.',
    '',
    '## Install',
    '',
    '1. Stop the application and back up the paths listed in hotfix-manifest.json.',
    '2. Extract this ZIP into the application root and overwrite matching files.',
    '3. Restart the application. Restarting clears the old 30-minute in-memory dashboard cache.',
    '4. Press Ctrl+F5 in the browser and compare the public dashboard with the local dashboard.',
    '',
    'No .env changes or dependency installation are required.',
    '',
    '## Rollback',
    '',
    'Stop the application, restore the backup files, and restart.',
    '',
    '## Excluded',
    '',
    'This package excludes dist/client, .env files, secrets, certificates, business data, logs, runtime state, node_modules, TypeScript sources, tests, dependency manifests and service scripts.'
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
      $_ -match '(^|/)(dist/client|\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
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

Write-Host '[OK] Purchase dashboard server sync hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
