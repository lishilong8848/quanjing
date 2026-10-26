param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "employee-onboarding-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageRoot = Join-Path $outputRoot $packageName
$zipPath = "$stageRoot.zip"
$sidecarPath = "$zipPath.sha256.txt"
$installerName = 'apply-employee-onboarding-hotfix.ps1'
$readmeName = 'README_EMPLOYEE_ONBOARDING_HOTFIX.md'

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childPath = [IO.Path]::GetFullPath($Child)
  $prefix = "$parentPath$([IO.Path]::DirectorySeparatorChar)"
  if (!$childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a path outside the allowed directory: $childPath"
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Copy-RuntimeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
    if ($file.Extension -eq '.map') {
      continue
    }
    $relativePath = $file.FullName.Substring($sourceRoot.Length + 1)
    $destinationPath = Join-Path $Destination $relativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destinationPath
  }
}

$buildOutputRoot = Join-Path $repoRoot 'dist'
$runtimeDirectoryNames = @('client', 'server', 'shared')
if (!$SkipBuild) {
  foreach ($runtimeDirectoryName in $runtimeDirectoryNames) {
    $buildDirectory = Join-Path $buildOutputRoot $runtimeDirectoryName
    Assert-ChildPath -Parent $buildOutputRoot -Child $buildDirectory
    if (Test-Path -LiteralPath $buildDirectory) {
      Remove-Item -LiteralPath $buildDirectory -Recurse -Force
    }
  }
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

$clientSource = Join-Path $buildOutputRoot 'client'
$serverSource = Join-Path $buildOutputRoot 'server'
$sharedSource = Join-Path $buildOutputRoot 'shared'
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
$requiredInputs = @(
  (Join-Path $clientSource 'index.html'),
  (Join-Path $serverSource 'main.js'),
  (Join-Path $serverSource 'modules/bitable-sync/employee-onboarding.controller.js'),
  (Join-Path $sharedSource 'employee-onboarding.js'),
  $installerSource,
  $readmeSource
)
foreach ($requiredPath in $requiredInputs) {
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required hotfix input is missing: $requiredPath"
  }
}

if (Test-Path -LiteralPath $stageRoot) {
  throw "Hotfix staging path already exists: $stageRoot"
}
if (Test-Path -LiteralPath $zipPath) {
  throw "Hotfix ZIP already exists: $zipPath"
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  $stageDistRoot = Join-Path $stageRoot 'dist'
  Copy-RuntimeDirectory -Source $clientSource -Destination (Join-Path $stageDistRoot 'client')
  Copy-RuntimeDirectory -Source $serverSource -Destination (Join-Path $stageDistRoot 'server')
  Copy-RuntimeDirectory -Source $sharedSource -Destination (Join-Path $stageDistRoot 'shared')
  Copy-Item -LiteralPath $installerSource -Destination (Join-Path $stageRoot $installerName)
  Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $stageRoot $readmeName)

  $payloadFiles = @(
    Get-ChildItem -LiteralPath $stageDistRoot -Recurse -File |
      Sort-Object FullName
  )
  if ($payloadFiles.Count -eq 0) {
    throw 'Compiled runtime payload is empty.'
  }
  if (@($payloadFiles | Where-Object Extension -eq '.map').Count -gt 0) {
    throw 'Source maps must not be included in the hotfix payload.'
  }

  $runtimeFiles = @(
    $payloadFiles | ForEach-Object {
      $relativePath = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
      [ordered]@{
        path = $relativePath
        size = $_.Length
        sha256 = Get-Sha256 -Path $_.FullName
      }
    }
  )
  $requiredRuntimePaths = @(
    'dist/client/index.html',
    'dist/server/main.js',
    'dist/server/modules/bitable-sync/employee-onboarding.controller.js',
    'dist/shared/employee-onboarding.js'
  )
  foreach ($requiredRuntimePath in $requiredRuntimePaths) {
    if (!($runtimeFiles.path -contains $requiredRuntimePath)) {
      throw "Required runtime file is missing from the payload: $requiredRuntimePath"
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    packageType = 'employee-onboarding-compiled-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    buildCommand = if ($SkipBuild) {
      'prevalidated dist/client, dist/server and dist/shared; packaging invoked with -SkipBuild'
    } else {
      'npm run build:prod'
    }
    replaceDirectories = @('dist/client', 'dist/server', 'dist/shared')
    scope = @(
      'monthly-schedule-common-tools-guest-entry',
      'employee-onboarding-responsive-dialog',
      'employee-onboarding-feishu-bitable-write-readback-cleanup',
      'employee-onboarding-optimistic-sync-and-recovery',
      'employee-onboarding-client-token-conflict-recovery'
    )
    dependencyInstallRequired = $false
    serviceRestartRequired = $true
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
    Get-ChildItem -LiteralPath $stageRoot -Recurse -File |
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

Write-Host '[OK] Employee onboarding hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageRoot"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
