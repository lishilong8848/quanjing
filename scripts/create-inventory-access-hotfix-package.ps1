param(
  [string]$OutputDir = 'release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "inventory-access-hotfix-$timestamp"
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

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed.'
  }
}

$compiledController = Join-Path $repoRoot 'dist/server/common/access/unified-access.controller.js'
if (!(Select-String -LiteralPath $compiledController -SimpleMatch 'inventory_admin' -Quiet)) {
  throw 'Compiled backend does not contain inventory administrator support.'
}
if (!(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dist/client') -File -Recurse |
  Select-String -SimpleMatch 'inventory_admin' -Quiet)) {
  throw 'Compiled client does not contain the inventory administrator login option.'
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $stageDir) {
  throw "Hotfix stage directory already exists: $stageDir"
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/client') -Destination (Join-Path $stageDir 'dist/client')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/server/common/access') -Destination (Join-Path $stageDir 'dist/server/common/access')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/server/modules/inventory-management') -Destination (Join-Path $stageDir 'dist/server/modules/inventory-management')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/server/app.module.js') -Destination (Join-Path $stageDir 'dist/server/app.module.js')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/server/app.module.d.ts') -Destination (Join-Path $stageDir 'dist/server/app.module.d.ts')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/shared/access-control.interface.js') -Destination (Join-Path $stageDir 'dist/shared/access-control.interface.js')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/shared/access-control.interface.d.ts') -Destination (Join-Path $stageDir 'dist/shared/access-control.interface.d.ts')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/shared/inventory-management.interface.js') -Destination (Join-Path $stageDir 'dist/shared/inventory-management.interface.js')
Copy-RequiredItem -Source (Join-Path $repoRoot 'dist/shared/inventory-management.interface.d.ts') -Destination (Join-Path $stageDir 'dist/shared/inventory-management.interface.d.ts')

Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-inventory-access.mjs') -Destination (Join-Path $stageDir 'scripts/configure-inventory-access.mjs')
Copy-RequiredItem -Source (Join-Path $repoRoot 'scripts/configure-inventory-access.ps1') -Destination (Join-Path $stageDir 'scripts/configure-inventory-access.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/start.ps1') -Destination (Join-Path $stageDir 'start.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/stop.ps1') -Destination (Join-Path $stageDir 'stop.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/start.cmd') -Destination (Join-Path $stageDir 'start.cmd')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/stop.cmd') -Destination (Join-Path $stageDir 'stop.cmd')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/apply-inventory-access-hotfix.ps1') -Destination (Join-Path $stageDir 'apply-inventory-access-hotfix.ps1')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/apply-inventory-access-hotfix.cmd') -Destination (Join-Path $stageDir 'apply-inventory-access-hotfix.cmd')
Copy-RequiredItem -Source (Join-Path $repoRoot 'deploy/README_INVENTORY_ACCESS_HOTFIX.md') -Destination (Join-Path $stageDir 'README_INVENTORY_ACCESS_HOTFIX.md')

$forbidden = Get-ChildItem -LiteralPath $stageDir -Force -Recurse | Where-Object {
  $_.Name -in @('.env', '.env.local', 'node_modules', 'data', 'logs', 'certs')
}
if ($forbidden) {
  throw "Refusing to package forbidden path: $($forbidden[0].FullName)"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stageDir,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

Write-Host '[OK] Inventory access minimal hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
