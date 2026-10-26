param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "unified-access-recovery-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"

function Copy-RequiredItem {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source)) {
    throw "Required item not found: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Write-HotfixManifest {
  param([string]$Stage)

  $files = @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse | Sort-Object FullName | ForEach-Object {
      $relativePath = $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
      [ordered]@{
        path = $relativePath
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    files = $files
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Stage 'hotfix-manifest.json') -Encoding UTF8
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed.'
  }
}

$compiledController = Join-Path $repoRoot 'dist/server/common/access/unified-access.controller.js'
if (!(Select-String -LiteralPath $compiledController -SimpleMatch 'supportsInventoryAdministrator' -Quiet)) {
  throw 'Compiled backend does not contain the unified access runtime probe.'
}
$compiledAccessService = Join-Path $repoRoot 'dist/server/common/access/unified-access.service.js'
foreach ($roleMarker in @('inventory_admin', 'purchase_admin', 'purchase_applicant', 'construction_admin')) {
  if (!(Select-String -LiteralPath $compiledAccessService -SimpleMatch $roleMarker -Quiet)) {
    throw "Compiled backend does not contain the required access role: $roleMarker."
  }
}
$compiledClientFiles = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dist/client') -File -Recurse
foreach ($roleMarker in @('inventory_admin', 'purchase_admin', 'purchase_applicant', 'construction_admin')) {
  if (!($compiledClientFiles | Select-String -SimpleMatch $roleMarker -Quiet)) {
    throw "Compiled client does not contain the required login role: $roleMarker."
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $stageDir) {
  throw "Hotfix stage directory already exists: $stageDir"
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/client') -Destination (Join-Path $stageDir 'dist/client')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/server') -Destination (Join-Path $stageDir 'dist/server')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/shared') -Destination (Join-Path $stageDir 'dist/shared')

foreach ($scriptName in @(
  'configure-unified-access.mjs',
  'configure-unified-access.ps1',
  'configure-inventory-access.mjs',
  'configure-inventory-access.ps1',
  'configure-purchase-access.mjs',
  'configure-purchase-access.ps1',
  'configure-construction-access.mjs',
  'configure-construction-access.ps1',
  'verify-unified-access-config.mjs',
  'ensure-purchase-inventory-config.mjs',
  'install-contract-preview-python-deps.ps1',
  'remove-legacy-contract-ocr.ps1'
)) {
  Copy-RequiredItem `
    -Source (Join-Path $repoRoot "scripts/$scriptName") `
    -Destination (Join-Path $stageDir "scripts/$scriptName")
}

foreach ($launcherName in @(
  'start.ps1',
  'stop.ps1',
  'start.cmd',
  'stop.cmd',
  'watchdog.ps1',
  'toggle-access-control.ps1',
  'toggle-access-control.cmd'
)) {
  Copy-RequiredItem `
    -Source (Join-Path $repoRoot "deploy/$launcherName") `
    -Destination (Join-Path $stageDir $launcherName)
}

Copy-RequiredItem `
  -Source (Join-Path $repoRoot 'deploy/apply-unified-access-recovery.ps1') `
  -Destination (Join-Path $stageDir 'apply-unified-access-recovery.ps1')
Copy-RequiredItem `
  -Source (Join-Path $repoRoot 'deploy/apply-unified-access-recovery.cmd') `
  -Destination (Join-Path $stageDir 'apply-unified-access-recovery.cmd')
Copy-RequiredItem `
  -Source (Join-Path $repoRoot 'deploy/README_UNIFIED_ACCESS_RECOVERY.md') `
  -Destination (Join-Path $stageDir 'README_UNIFIED_ACCESS_RECOVERY.md')

$forbidden = Get-ChildItem -LiteralPath $stageDir -Force -Recurse | Where-Object {
  $_.Name -in @('.env', '.env.local', 'node_modules', 'data', 'logs', 'certs', '.runtime')
}
if ($forbidden) {
  throw "Refusing to package forbidden path: $($forbidden[0].FullName)"
}

Write-HotfixManifest -Stage $stageDir

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stageDir,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
$archiveHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Set-Content -LiteralPath "$zipPath.sha256.txt" -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ASCII

Write-Host '[OK] Unified access recovery hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
