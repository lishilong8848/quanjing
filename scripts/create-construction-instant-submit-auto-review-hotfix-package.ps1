param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-instant-submit-auto-review-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageRoot = Join-Path $outputRoot $packageName
$zipPath = "$stageRoot.zip"
$sidecarPath = "$zipPath.sha256.txt"
$installerName =
  'apply-construction-instant-submit-auto-review-hotfix.ps1'
$readmeName = 'README_CONSTRUCTION_INSTANT_SUBMIT_AUTO_REVIEW.md'

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

$buildOutputRoot = Join-Path $repoRoot 'dist'
$cleanBuildDirectories = @('client', 'server', 'shared')
$serverBuildInfoPath = Join-Path $buildOutputRoot 'tsconfig.node.tsbuildinfo'
if (!$SkipBuild) {
  foreach ($cleanBuildDirectory in $cleanBuildDirectories) {
    $cleanBuildPath = Join-Path $buildOutputRoot $cleanBuildDirectory
    Assert-ChildPath `
      -Parent $buildOutputRoot `
      -Child $cleanBuildPath
    if (Test-Path -LiteralPath $cleanBuildPath) {
      Remove-Item -LiteralPath $cleanBuildPath -Recurse -Force
    }
  }
  Assert-ChildPath `
    -Parent $buildOutputRoot `
    -Child $serverBuildInfoPath
  if (Test-Path -LiteralPath $serverBuildInfoPath -PathType Leaf) {
    Remove-Item -LiteralPath $serverBuildInfoPath -Force
  }
  Push-Location $repoRoot
  try {
    & npm run build:server
    if ($LASTEXITCODE -ne 0) {
      throw 'Server production build failed; hotfix package was not created.'
    }
    & npm run build:client
    if ($LASTEXITCODE -ne 0) {
      throw 'Client production build failed; hotfix package was not created.'
    }
  } finally {
    Pop-Location
  }
}

$clientSource = Join-Path $repoRoot 'dist/client'
$serverSource = Join-Path $repoRoot 'dist/server'
$sharedSource = Join-Path $repoRoot 'dist/shared'
$startScriptSource = Join-Path $repoRoot 'deploy/start.ps1'
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
$requiredInputs = @(
  (Join-Path $clientSource 'index.html')
  (Join-Path $serverSource 'main.js')
  (Join-Path $sharedSource 'construction-manual-review-policy.js')
  $startScriptSource
  $installerSource
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

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
try {
  $stageDistRoot = Join-Path $stageRoot 'dist'
  New-Item -ItemType Directory -Path $stageDistRoot -Force | Out-Null
  Copy-Item -LiteralPath $clientSource -Destination $stageDistRoot -Recurse
  Copy-Item -LiteralPath $serverSource -Destination $stageDistRoot -Recurse
  Copy-Item -LiteralPath $sharedSource -Destination $stageDistRoot -Recurse
  Copy-Item `
    -LiteralPath $startScriptSource `
    -Destination (Join-Path $stageRoot 'start.ps1')
  Copy-Item `
    -LiteralPath $installerSource `
    -Destination (Join-Path $stageRoot $installerName)
  Copy-Item `
    -LiteralPath $readmeSource `
    -Destination (Join-Path $stageRoot $readmeName)

  $payloadFiles = @(
    Get-ChildItem -LiteralPath $stageDistRoot -File -Recurse
    Get-Item -LiteralPath (Join-Path $stageRoot 'start.ps1')
  )
  $runtimeFiles = @(
    $payloadFiles |
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
    throw 'Compiled runtime payload is empty.'
  }
  if (!($runtimeFiles.path -contains 'dist/client/index.html')) {
    throw 'Compiled client entry is missing from the payload.'
  }
  if (!($runtimeFiles.path -contains 'dist/server/main.js')) {
    throw 'Compiled server entry is missing from the payload.'
  }
  if (
    !(
      $runtimeFiles.path -contains
        'dist/shared/construction-manual-review-policy.js'
    )
  ) {
    throw 'Compiled construction manual-review policy is missing from the payload.'
  }
  if (!($runtimeFiles.path -contains 'start.ps1')) {
    throw 'Production launcher is missing from the payload.'
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    packageType =
      'construction-instant-submit-auto-review-compiled-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    buildCommand = if ($SkipBuild) {
      'prevalidated dist/client, dist/server and dist/shared; packaging invoked with -SkipBuild'
    } else {
      'npm run build:server; npm run build:client'
    }
    replaceDirectories = @('dist/client', 'dist/server', 'dist/shared')
    replaceFiles = @('start.ps1')
    scope = @(
      'construction-management-instant-optimistic-submit'
      'construction-management-background-sync-and-rollback'
      'construction-management-admin-review-auto-approval'
      'construction-management-construction-admin-review-auto-approval'
      'construction-management-sub-admin-review-auto-approval'
      'construction-management-file-picker-only'
      'construction-management-permit-validity-range-required-for-auto-approval'
      'construction-management-valid-permit-no-repeat-submit'
      'construction-management-permit-reupload-replaces-previous-file'
      'construction-management-single-submit-permit-renewal'
      'construction-management-permit-optimistic-green-state'
      'server-startup-readiness-env-local-consistency'
      'server-startup-public-session-readiness-probe'
      'construction-management-ai-ocr-manual-only-switch'
      'construction-management-personnel-certificate-matching-retained'
      'unified-access-login-single-dialog'
      'unified-access-session-commit-before-route-guard'
    )
    dependencyInstallRequired = $false
    serviceRestartRequired = $true
    secretsIncluded = $false
    files = $runtimeFiles
  }
  $manifest |
    ConvertTo-Json -Depth 8 |
    Set-Content `
      -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json') `
      -Encoding UTF8

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

Write-Host '[OK] Construction instant-submit and auto-review hotfix created.'
Write-Host "[OK] Folder: $stageRoot"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
