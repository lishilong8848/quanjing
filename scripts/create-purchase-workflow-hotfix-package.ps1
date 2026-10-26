param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-base-workflow-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_PURCHASE_BASE_WORKFLOW_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'

$serverRelativePaths = @(
  'dist/server/runtime-env.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js'
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
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileExcludes {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $content = Get-Content -Raw -LiteralPath (Join-Path $repoRoot $RelativePath) -Encoding UTF8
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
    purpose = 'Feishu Base owns purchase workflow; preserve real applicant identity'
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

Assert-CompiledFileContains `
  -RelativePath 'dist/server/runtime-env.js' `
  -Markers @('PURCHASE_WORKFLOW_PROGRAM_ENABLED', "= 'false'")
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-application.service.js' `
  -Markers @('buildPurchaseExecutionFields')
Assert-CompiledFileExcludes `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-application.service.js' `
  -Markers @('enqueueApprovalRequests')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.controller.js' `
  -Markers @('resolveApplicantForBuilding', 'workflowService.assertEnabled')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js' `
  -Markers @('reconcileProgramCreatedPurchaseRecords')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-workflow.service.js' `
  -Markers @('assertEnabled')

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
    '# Purchase Feishu Base workflow hotfix',
    '',
    '## Scope',
    '',
    '- Purchase applications keep the selected, server-verified real applicant identity.',
    '- Submission and execution records are synchronized to Feishu Base.',
    '- Existing Feishu Base workflows remain the sole owner of approval and notifications.',
    '- The retired program workflow stays disabled even if a legacy server .env value is true.',
    '- This package does not change Base fields, views, records, or workflow definitions.',
    '',
    '## Deployment',
    '',
    '1. Stop the application with the existing stop.cmd or service manager.',
    '2. Back up dist/client and every server file listed in hotfix-manifest.json.',
    '3. Remove or move the old dist/client directory so old hashed chunks cannot remain.',
    '4. Extract this ZIP directly into the application root and overwrite matching paths.',
    '5. Start the application with the existing start.cmd or service manager.',
    '6. Press Ctrl+F5 and submit one controlled purchase request for verification.',
    '',
    'No server environment edit or new dependency installation is required.',
    '',
    '## Rollback',
    '',
    'Stop the application, restore the backed-up dist/client directory and listed server files, then restart.',
    '',
    '## Exclusions',
    '',
    'No .env files, secrets, certificates, business data, logs, runtime ledgers, node_modules, source files, tests, dependency manifests, or start/stop scripts are included.'
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

  $forbiddenFileNames = @(
    'purchase-workflow-ledger.json',
    'package.json',
    'package-lock.json'
  )
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
      $leafName -like 'enable-purchase-workflow.*' -or
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

Write-Host '[OK] Purchase Feishu Base workflow hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
