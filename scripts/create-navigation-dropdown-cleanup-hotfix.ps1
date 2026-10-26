param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "navigation-dropdown-cleanup-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageRoot = Join-Path $outputRoot $packageName
$zipPath = "$stageRoot.zip"
$sidecarPath = "$zipPath.sha256.txt"
$installerName = 'apply-navigation-dropdown-cleanup-hotfix.ps1'
$readmeName = 'README_NAVIGATION_DROPDOWN_CLEANUP_HOTFIX.md'

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

function Copy-RuntimeDirectory {
  param([string]$Source, [string]$Destination)

  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
    if ($file.Extension -eq '.map') {
      continue
    }
    $relativePath = $file.FullName.Substring($sourceRoot.Length + 1)
    $targetPath = Join-Path $Destination $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  }
}

function Get-StageRelativeFiles {
  param([string]$Root)

  return @(
    Get-ChildItem -LiteralPath $Root -Recurse -File |
      ForEach-Object { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') } |
      Sort-Object
  )
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
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
foreach ($requiredPath in @(
    (Join-Path $clientSource 'index.html'),
    $installerSource,
    $readmeSource
  )) {
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required hotfix input is missing: $requiredPath"
  }
}

$clientFiles = @(Get-ChildItem -LiteralPath $clientSource -Recurse -File)
if ($clientFiles.Count -lt 10) {
  throw 'Compiled client tree is unexpectedly incomplete.'
}
if (@($clientFiles | Where-Object Extension -eq '.map').Count -gt 0) {
  throw 'Compiled client tree contains source maps; rebuild without source maps before packaging.'
}

$navigationSource = Join-Path $repoRoot 'client/src/components/GlobalNavigation.tsx'
if (!(Test-Path -LiteralPath $navigationSource -PathType Leaf)) {
  throw "Navigation source is missing: $navigationSource"
}
$navigationSourceContent = Get-Content -LiteralPath $navigationSource -Raw
foreach ($requiredMarker in @('showDomainHeader = true', 'showDomainHeader={false}', 'data-navigation-domain')) {
  if (!$navigationSourceContent.Contains($requiredMarker)) {
    throw "Navigation source is missing required cleanup marker: $requiredMarker"
  }
}

foreach ($requiredMarker in @('data-navigation-domain', 'aria-labelledby')) {
  if (@($clientFiles | Select-String -SimpleMatch -Pattern $requiredMarker -List).Count -eq 0) {
    throw "Compiled client is missing required navigation marker: $requiredMarker"
  }
}

foreach ($target in @($stageRoot, $zipPath, $sidecarPath)) {
  Assert-ChildPath -Parent $outputRoot -Child $target
  if (Test-Path -LiteralPath $target) {
    throw "Hotfix output already exists: $target"
  }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-RuntimeDirectory -Source $clientSource -Destination (Join-Path $stageRoot 'dist/client')
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
    packageType = 'navigation-dropdown-cleanup-client-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    buildCommand = if ($SkipBuild) { 'prevalidated dist/client; packaging invoked with -SkipBuild' } else { 'npm run build:prod' }
    replaceDirectories = @('dist/client')
    scope = @('navigation-domain-popover-removes-redundant-category-header-and-description')
    dependencyInstallRequired = $false
    serviceRestartRequired = $true
    secretsIncluded = $false
    files = $runtimeFiles
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json') -Encoding UTF8

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $expectedFiles = Get-StageRelativeFiles -Root $stageRoot
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archiveFiles = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Sort-Object
    )
    if (
      $archiveFiles.Count -ne $expectedFiles.Count -or
      @($archiveFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
      @($expectedFiles | Where-Object { $_ -notin $archiveFiles }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = Get-Sha256 -Path $zipPath
  [IO.File]::WriteAllText(
    $sidecarPath,
    "$archiveHash  $([IO.Path]::GetFileName($zipPath))`r`n",
    [Text.Encoding]::ASCII
  )
} catch {
  foreach ($target in @($stageRoot, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
  throw
}

Write-Host '[OK] Navigation dropdown cleanup hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageRoot"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
