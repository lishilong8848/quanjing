param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-online-approval-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$readmeRelativePath = 'README_PURCHASE_ONLINE_APPROVAL_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'

$serverRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-access-policy.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.service.js',
  'dist/server/modules/purchase-inventory/purchase-online-approval.service.js'
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

function Assert-CompiledClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  if (!(Test-Path -LiteralPath (Join-Path $clientRoot 'index.html') -PathType Leaf)) {
    throw 'Compiled client index.html was not found.'
  }
  if (!(Test-Path -LiteralPath (Join-Path $clientRoot 'main.js') -PathType Leaf)) {
    throw 'Compiled client main.js was not found.'
  }
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
  '/api/purchase-inventory/records/',
  'decision:"approved"',
  'decision:"rejected"',
  'resultLabel'
)
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.controller.js' `
  -Markers @('records/:recordId/approval', 'PurchaseOnlineApprovalService')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.module.js' `
  -Markers @('PurchaseOnlineApprovalService')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-online-approval.service.js' `
  -Markers @('runSerialized', 'approvalCompleted', 'purchaseMethod', 'REJECTED_PROGRAM_STATUS')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-access-policy.service.js' `
  -Markers @('assertTypedUpdateIdsMatch', 'rejected')
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js' `
  -Markers @('purchaseMethod ===', "stage: 'rejected'")
Assert-CompiledFileContains `
  -RelativePath 'dist/server/modules/purchase-inventory/purchase-inventory.service.js' `
  -Markers @('return this.getDashboard(true)')

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
  Copy-Item `
    -LiteralPath (Join-Path $repoRoot $clientRelativePath) `
    -Destination (Join-Path $stageDir $clientRelativePath) `
    -Recurse `
    -Force
  foreach ($relativePath in $serverRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }

  $readmeLines = @(
    '# Purchase online approval hotfix',
    '',
    '## Scope',
    '',
    '- Administrators can open an approval-stage purchase request and confirm or reject it online.',
    '- Approval writes the existing purchase method plus the existing approval-completed checkbox.',
    '- Rejection writes the existing Base rejection option, the approval-completed checkbox, and the existing program-status trigger.',
    '- The existing Feishu Base workflow remains responsible for changing the purchase Stage field.',
    '- The package does not change Base fields, views, workflow definitions, environment variables, or dependencies.',
    '',
    '## Deployment',
    '',
    '1. Stop the application with the existing stop.cmd or service manager.',
    '2. Back up dist/client and every server file listed in hotfix-manifest.json.',
    '3. Remove or move the old dist/client directory so old hashed chunks cannot remain.',
    '4. Extract this ZIP directly into the application root and overwrite matching paths.',
    '5. Start the application with the existing start.cmd or service manager.',
    '6. Press Ctrl+F5, sign in as an administrator, and verify one controlled approval.',
    '',
    'No server .env edit or new dependency installation is required.',
    '',
    '## Rollback',
    '',
    'Stop the application, restore the backed-up dist/client directory and listed server files, then restart.',
    '',
    '## Exclusions',
    '',
    'No .env files, secrets, certificates, business data, logs, node_modules, source files, tests, sourcemaps, dependency manifests, or service scripts are included.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $payloadPaths = @(Get-StageRelativePaths -Stage $stageDir)
  $manifestFiles = @(
    $payloadPaths | ForEach-Object {
      $fullPath = Join-Path $stageDir $_.Replace(
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
    purpose = 'Administrator online purchase approval backed by Feishu Base workflow triggers'
    files = $manifestFiles
  } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $stageDir $manifestRelativePath) -Encoding UTF8

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $leafName = [IO.Path]::GetFileName($_)
      $extension = [IO.Path]::GetExtension($_)
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
      $leafName -in @('package.json', 'package-lock.json', 'purchase-workflow-ledger.json') -or
      $extension -in @('.map', '.ts', '.tsx', '.spec', '.log', '.pem', '.key', '.pfx', '.p12')
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
      @($actualFiles | Where-Object { $_ -notin $archivePaths }).Count -gt 0 -or
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
  foreach ($path in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $path) {
      Assert-ChildPath -Parent $outputRoot -Child $path
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Purchase online approval hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
