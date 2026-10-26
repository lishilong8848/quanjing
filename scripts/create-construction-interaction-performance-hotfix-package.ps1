param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-interaction-performance-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageRoot = Join-Path $outputRoot $packageName
$zipPath = "$stageRoot.zip"
$sidecarPath = "$zipPath.sha256.txt"
$installerName =
  'apply-construction-interaction-performance-hotfix.ps1'
$readmeName = 'README_CONSTRUCTION_INTERACTION_PERFORMANCE.md'

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childPath = [IO.Path]::GetFullPath($Child)
  $prefix = "$parentPath$([IO.Path]::DirectorySeparatorChar)"
  if (!$childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a path outside the output directory: $childPath"
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (
    Get-FileHash -LiteralPath $Path -Algorithm SHA256
  ).Hash.ToUpperInvariant()
}

if (!$SkipBuild) {
  Push-Location $repoRoot
  try {
    & npm run build:client
    if ($LASTEXITCODE -ne 0) {
      throw 'Client production build failed; hotfix package was not created.'
    }
  } finally {
    Pop-Location
  }
}

$clientSource = Join-Path $repoRoot 'dist/client'
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
foreach ($requiredPath in @($clientSource, $installerSource, $readmeSource)) {
  if (!(Test-Path -LiteralPath $requiredPath)) {
    throw "Required hotfix input is missing: $requiredPath"
  }
}
if (Test-Path -LiteralPath $stageRoot) {
  throw "Hotfix staging path already exists: $stageRoot"
}
if (Test-Path -LiteralPath $zipPath) {
  throw "Hotfix ZIP already exists: $zipPath"
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
try {
  $stageClientParent = Join-Path $stageRoot 'dist'
  New-Item -ItemType Directory -Path $stageClientParent -Force | Out-Null
  Copy-Item -LiteralPath $clientSource -Destination $stageClientParent -Recurse
  Copy-Item -LiteralPath $installerSource -Destination (Join-Path $stageRoot $installerName)
  Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $stageRoot $readmeName)

  $runtimeFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $stageRoot 'dist/client') -File -Recurse |
      Sort-Object FullName |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($stageRoot.Length + 1).
          Replace('\', '/')
        [ordered]@{
          path = $relativePath
          size = $_.Length
          sha256 = Get-Sha256 -Path $_.FullName
        }
      }
  )
  if ($runtimeFiles.Count -eq 0) {
    throw 'Compiled client payload is empty.'
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    packageType =
      'construction-interaction-performance-compiled-client-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    buildCommand = if ($SkipBuild) {
      'prevalidated dist/client; packaging invoked with -SkipBuild'
    } else {
      'npm run build:client'
    }
    replaceDirectories = @('dist/client')
    scope = @(
      'construction-management-render-isolation'
      'construction-management-stable-project-card-callbacks'
      'construction-management-crew-row-memoization'
      'construction-management-offscreen-crew-layout-skip'
    )
    dependencyInstallRequired = $false
    secretsIncluded = $false
    files = $runtimeFiles
  }
  $manifest |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json') -Encoding UTF8

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $expectedFiles = @(
    Get-ChildItem -LiteralPath $stageRoot -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
      } |
      Sort-Object
  )
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
      @($archiveFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0
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

Write-Host '[OK] Construction interaction performance hotfix created.'
Write-Host "[OK] Folder: $stageRoot"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
