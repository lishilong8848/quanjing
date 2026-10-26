param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-work-type-submit-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"

$runtimeRelativePath =
  'dist/server/modules/duty-schedule/duty-schedule.service.js'
$readmeRelativePath =
  'README_CONSTRUCTION_WORK_TYPE_SUBMIT_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'

$baselinePackageName =
  'construction-daily-verification-hotfix-20260723-175514.zip'
$baselinePackagePath = Join-Path $repoRoot "output/hotfix/$baselinePackageName"
$baselinePackageSha256 =
  '6B4EB59BF9DC0C5B255981A93368D3F0156164B1D4E7455120C8EC026A314C95'
$baselineRuntimeSha256 =
  'F6DBC59C37876145B50F0F04FA6F96CAD6DB3D36183D2AF0AF56F71B50716C7B'
$currentRuntimeSha256 =
  'C09B2FF48C14565A27BC8BE8F563A8A59952DEB03C37A175265A29BB55555F85'

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
    throw "Refusing to use a path outside the output directory: $Child"
  }
}

function Get-Sha256 {
  param([string]$Path)

  return (
    Get-FileHash -LiteralPath $Path -Algorithm SHA256
  ).Hash.ToUpperInvariant()
}

function Assert-FileHash {
  param(
    [string]$Path,
    [string]$ExpectedSha256
  )

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file is missing: $Path"
  }
  $actualSha256 = Get-Sha256 -Path $Path
  if ($actualSha256 -ne $ExpectedSha256) {
    throw (
      "SHA256 mismatch for $Path. Expected $ExpectedSha256, " +
      "got $actualSha256."
    )
  }
}

function Get-ZipEntryHash {
  param([System.IO.Compression.ZipArchiveEntry]$Entry)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  $stream = $Entry.Open()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return ([BitConverter]::ToString($bytes)).Replace('-', '')
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

function Get-RelativeFiles {
  param([string]$Root)

  $resolvedRoot = [IO.Path]::GetFullPath($Root)
  return @(
    Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($resolvedRoot.Length).
          TrimStart('\', '/').
          Replace('\', '/')
      } |
      Sort-Object
  )
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
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

foreach ($path in @($stageDir, $zipPath, $sidecarPath)) {
  Assert-ChildPath -Parent $outputRoot -Child $path
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
  if (Test-Path -LiteralPath $target) {
    throw "Hotfix output already exists: $target"
  }
}

Assert-FileHash `
  -Path $baselinePackagePath `
  -ExpectedSha256 $baselinePackageSha256

Add-Type -AssemblyName System.IO.Compression.FileSystem
$baselineArchive = [System.IO.Compression.ZipFile]::OpenRead(
  $baselinePackagePath
)
try {
  $baselineRuntimeEntry = $baselineArchive.Entries |
    Where-Object {
      $_.FullName.Replace('\', '/') -eq $runtimeRelativePath
    } |
    Select-Object -First 1
  if (!$baselineRuntimeEntry) {
    throw (
      "Required runtime is missing from baseline package: " +
      $runtimeRelativePath
    )
  }
  $actualBaselineRuntimeSha256 =
    Get-ZipEntryHash -Entry $baselineRuntimeEntry
  if ($actualBaselineRuntimeSha256 -ne $baselineRuntimeSha256) {
    throw (
      "Baseline runtime SHA256 mismatch. Expected " +
      "$baselineRuntimeSha256, got $actualBaselineRuntimeSha256."
    )
  }
} finally {
  $baselineArchive.Dispose()
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Server production build failed; hotfix package was not created.'
  }
}

$runtimeSource = Join-Path $repoRoot $runtimeRelativePath
Assert-FileHash `
  -Path $runtimeSource `
  -ExpectedSha256 $currentRuntimeSha256

$compiledSource = Get-Content -Raw -LiteralPath $runtimeSource -Encoding UTF8
if (
  $compiledSource -notmatch
    "extractDisplayText\)\(fingerprintValue,\s*''\)\.trim\(\)" -or
  $compiledSource -notmatch
    'inherited\[reviewConfig\.fingerprintField\]\s*=\s*fingerprintText'
) {
  throw (
    'Compiled runtime does not contain the required Multiline ' +
    'fingerprint normalization behavior.'
  )
}

$sourceRevision = (& git rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or !$sourceRevision) {
  $sourceRevision = 'unknown'
} else {
  $sourceRevision = $sourceRevision.Trim()
}
$sourceWorktreeDirty = [bool](& git status --porcelain 2>$null)
$archiveHash = $null

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  Copy-RequiredFile `
    -Source $runtimeSource `
    -Destination (Join-Path $stageDir $runtimeRelativePath)

  $readmeLines = @(
    '# Construction work-type submit minimal hotfix',
    '',
    '## Scope',
    '',
    '- Fixes the first-step work-type submit failure caused by copying a Feishu Multiline rich-text array back into the manual-review fingerprint field.',
    '- Normalizes only the inherited manual-review fingerprint to a plain string before writing.',
    '- Keeps work-type verification first and personnel verification second.',
    '- Does not add, remove, or change OCR, vision-audit, or manual-review behavior.',
    '',
    '## Required baseline',
    '',
    "- The server must already include $baselinePackageName, or duty-schedule.service.js must have SHA256 $baselineRuntimeSha256.",
    "- Baseline package SHA256: $baselinePackageSha256",
    '',
    '## Install',
    '',
    '1. Stop the existing Node service.',
    "2. Back up $runtimeRelativePath on the server.",
    '3. Extract this ZIP into the existing application root and overwrite the matching file. Do not create an extra nested directory.',
    '4. Restart the service using the existing server procedure.',
    '',
    '## Verify',
    '',
    '1. Open Construction Management and select a project with a historically approved permit.',
    '2. Select the current work type in the first-step work-type verification dialog and submit.',
    '3. The submit must succeed without TextFieldConvFail or Multiline must be a string.',
    '4. Confirm that personnel verification still matches certificates against the saved daily work types.',
    '',
    '## Rollback',
    '',
    "Stop the service, restore the backed-up $runtimeRelativePath, and restart.",
    '',
    '## Exclusions',
    '',
    'This package contains no source files, tests, frontend files, source maps, .env files, secrets, certificates, business data, logs, node_modules, package.json, or package-lock.json.'
  )
  [IO.File]::WriteAllLines(
    (Join-Path $stageDir $readmeRelativePath),
    $readmeLines,
    [Text.UTF8Encoding]::new($true)
  )

  $payloadPaths = @($runtimeRelativePath, $readmeRelativePath)
  $payloadFiles = @(
    $payloadPaths | ForEach-Object {
      $fullPath = Join-Path $stageDir $_
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $fullPath).Length
        sha256 = Get-Sha256 -Path $fullPath
      }
    }
  )
  $manifest = [ordered]@{
    schemaVersion = 1
    packageType =
      'construction-work-type-submit-multiline-minimal-compiled-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    sourceRevision = $sourceRevision
    sourceWorktreeDirty = $sourceWorktreeDirty
    buildCommand = if ($SkipBuild) {
      'prevalidated dist; packaging invoked with -SkipBuild'
    } else {
      'npm run build:server'
    }
    requiredPackages = @(
      [ordered]@{
        file = $baselinePackageName
        sha256 = $baselinePackageSha256
      }
    )
    baselines = [ordered]@{
      files = @(
        [ordered]@{
          path = $runtimeRelativePath
          sha256 = $baselineRuntimeSha256
        }
      )
    }
    replaceFiles = @($runtimeRelativePath)
    scope = @(
      'construction-daily-work-type-submit-multiline-normalization',
      'construction-manual-review-fingerprint-inheritance'
    )
    dependencyInstallRequired = $false
    secretsIncluded = $false
    files = $payloadFiles
  }
  [IO.File]::WriteAllText(
    (Join-Path $stageDir $manifestRelativePath),
    ($manifest | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($true)
  )

  $expectedFiles = @(
    $runtimeRelativePath,
    $readmeRelativePath,
    $manifestRelativePath
  ) | Sort-Object
  $actualFiles = @(Get-RelativeFiles -Root $stageDir)
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $forbiddenPattern = '\.(map|ts|tsx|d\.ts|spec|log|pem|key)$'
  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $_ -match
        '(^|/)(\.env[^/]*|node_modules|data|logs|certs|sourcemaps)(/|$)' -or
      $_ -match $forbiddenPattern -or
      $_ -in @('package.json', 'package-lock.json')
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $payloadHashes = @{}
  foreach ($file in $payloadFiles) {
    $payloadHashes[$file.path] = $file.sha256
  }
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archiveEntries = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        Sort-Object FullName
    )
    $archivePaths = @(
      $archiveEntries |
        ForEach-Object { $_.FullName.Replace('\', '/') }
    )
    if (
      $archivePaths.Count -ne $actualFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $actualFiles }).Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match staged hotfix files.'
    }
    foreach ($entry in $archiveEntries) {
      $relativePath = $entry.FullName.Replace('\', '/')
      if ($payloadHashes.ContainsKey($relativePath)) {
        $entryHash = Get-ZipEntryHash -Entry $entry
        if ($entryHash -ne $payloadHashes[$relativePath]) {
          throw "ZIP entry hash mismatch: $relativePath"
        }
      }
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
  $recordedHash = (
    [IO.File]::ReadAllText($sidecarPath)
  ).Trim().Split(' ')[0]
  if ($recordedHash -ne $archiveHash) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
} catch {
  foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item `
        -LiteralPath $target `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Construction work-type submit hotfix created.' `
  -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
