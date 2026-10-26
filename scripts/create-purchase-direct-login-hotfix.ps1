param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-direct-login-session-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageRoot = Join-Path $outputRoot $packageName
$zipPath = "$stageRoot.zip"
$sidecarPath = "$zipPath.sha256.txt"
$installerName = 'apply-purchase-direct-login-hotfix.ps1'
$readmeName = 'README_PURCHASE_DIRECT_LOGIN_HOTFIX.md'

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childPath = [IO.Path]::GetFullPath($Child)
  $prefix = "$parentPath$([IO.Path]::DirectorySeparatorChar)"
  if (!$childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to access a path outside the allowed directory: $childPath"
  }
}

function Get-Sha256 {
  param([string]$Path)

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Copy-ClientRuntime {
  param([string]$Source, [string]$Destination)

  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
    if ($file.Extension -eq '.map') { continue }
    $relativePath = $file.FullName.Substring($sourceRoot.Length + 1)
    $targetPath = Join-Path $Destination $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  }
}

if (!$SkipBuild) {
  Push-Location $repoRoot
  try {
    & npm run build:prod
    if ($LASTEXITCODE -ne 0) {
      throw 'Production build failed; hotfix package was not created.'
    }
  } finally {
    Pop-Location
  }
}

$clientSource = Join-Path $repoRoot 'dist/client'
$providerSource = Join-Path $repoRoot 'client/src/access/AccessProvider.tsx'
$accessEventsSource = Join-Path $repoRoot 'client/src/access/access-events.ts'
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
foreach ($requiredPath in @((Join-Path $clientSource 'index.html'), (Join-Path $clientSource 'main.js'), $providerSource, $accessEventsSource, $installerSource, $readmeSource)) {
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required hotfix input is missing: $requiredPath"
  }
}

$providerContent = Get-Content -LiteralPath $providerSource -Raw -Encoding UTF8
foreach ($marker in @('const confirmedSession = await getAccessSession();', 'isConfirmedLoginSession(nextSession, confirmedSession)')) {
  if (!$providerContent.Contains($marker)) {
    throw "Direct-login session confirmation source marker is missing: $marker"
  }
}

$accessEventsContent = Get-Content -LiteralPath $accessEventsSource -Raw -Encoding UTF8
foreach ($marker in @('isIndependentAuthenticationEndpoint', "normalized.includes('/api/authnpaas/')")) {
  if (!$accessEventsContent.Contains($marker)) {
    throw "Independent authentication exclusion source marker is missing: $marker"
  }
}

$compiledClientContent = Get-Content -LiteralPath (Join-Path $clientSource 'main.js') -Raw -Encoding UTF8
if ($compiledClientContent -notmatch '/api/access/[^\r\n]{0,400}/api/authnpaas/') {
  throw 'Compiled client does not contain the unified-access exclusion for independent Feishu authentication failures.'
}

$clientFiles = @(Get-ChildItem -LiteralPath $clientSource -Recurse -File)
if ($clientFiles.Count -lt 10) { throw 'Compiled client tree is unexpectedly incomplete.' }
if (@($clientFiles | Where-Object Extension -eq '.map').Count -gt 0) {
  throw 'Compiled client tree contains source maps; rebuild before packaging.'
}

foreach ($target in @($stageRoot, $zipPath, $sidecarPath)) {
  Assert-ChildPath -Parent $outputRoot -Child $target
  if (Test-Path -LiteralPath $target) { throw "Hotfix output already exists: $target" }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-ClientRuntime -Source $clientSource -Destination (Join-Path $stageRoot 'dist/client')
  Copy-Item -LiteralPath $installerSource -Destination (Join-Path $stageRoot $installerName)
  Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $stageRoot $readmeName)

  $runtimeFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $stageRoot 'dist/client') -Recurse -File |
      Sort-Object FullName |
      ForEach-Object {
        [ordered]@{
          path = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
          size = $_.Length
          sha256 = Get-Sha256 -Path $_.FullName
        }
      }
  )
  if ($runtimeFiles.Count -eq 0 -or !($runtimeFiles.path -contains 'dist/client/index.html')) {
    throw 'Compiled client payload is incomplete.'
  }
  if (@($runtimeFiles.path | Where-Object { $_ -notmatch '^dist/client/' -or $_.EndsWith('.map') }).Count -gt 0) {
    throw 'Client payload contains an unsafe path.'
  }

  [ordered]@{
    schemaVersion = 1
    packageType = 'purchase-direct-login-session-client-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    buildCommand = if ($SkipBuild) { 'prevalidated dist/client; packaging invoked with -SkipBuild' } else { 'npm run build:prod' }
    replaceDirectories = @('dist/client')
    scope = @(
      'purchase-inventory-management-direct-login-server-session-confirmation',
      'independent-feishu-authentication-failure-does-not-invalidate-unified-session'
    )
    dependencyInstallRequired = $false
    serviceRestartRequired = $true
    secretsIncluded = $false
    files = $runtimeFiles
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json') -Encoding UTF8

  [System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $expectedFiles = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File | ForEach-Object { $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/') } | Sort-Object)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archiveFiles = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
    if ($archiveFiles.Count -ne $expectedFiles.Count -or @($archiveFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or @($expectedFiles | Where-Object { $_ -notin $archiveFiles }).Count -gt 0) {
      throw 'ZIP entries do not exactly match staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = Get-Sha256 -Path $zipPath
  [IO.File]::WriteAllText($sidecarPath, "$archiveHash  $([IO.Path]::GetFileName($zipPath))`r`n", [Text.Encoding]::ASCII)
} catch {
  foreach ($target in @($stageRoot, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
  throw
}

Write-Host '[OK] Purchase direct-login session hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageRoot"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
