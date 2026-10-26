param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-daily-verification-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientExtractDir = Join-Path $outputRoot (
  ".construction-daily-client-baseline-$timestamp-$PID"
)
$serverExtractDir = Join-Path $outputRoot (
  ".construction-daily-server-baseline-$timestamp-$PID"
)

$manifestName = 'hotfix-manifest.json'
$readmeName = 'README_CONSTRUCTION_DAILY_VERIFICATION_HOTFIX.md'
$installerName = 'apply-construction-daily-verification-hotfix.ps1'
$installerSource = Join-Path $repoRoot "deploy/$installerName"

$clientBaselineName =
  'construction-progress-ui-hotfix-20260723-131315.zip'
$clientBaselinePath = Join-Path $repoRoot (
  "output/hotfix/$clientBaselineName"
)
$clientBaselineSha256 =
  '691F1A5382252209D68EDED95849348D80683AE088BDB8EA814634C7094EF059'
$clientBaselineMainSha256 =
  '7E6A7D0CC56D13DBAFDED664980C34D2A61A7B3958525887A54727AE76F5BFAF'
$clientBaselineChunkPath = 'dist/client/chunks/3668.c2fff727.js'
$clientBaselineChunkSha256 =
  '455380BC4C91EC4AA020444DEF263032D7EC192634687DE03C62396824EDF132'
$currentClientChunkPath = 'dist/client/chunks/3668.c99500bd.js'
$currentClientChunkSha256 =
  'CF455AF2DEDBC3582BED68CF2DD658D44C4E4E2AC5824178FE5729E76B1DED23'
$clientBaselineAssetHash = 'c2fff727'
$currentClientAssetHash = 'c99500bd'
$expectedClientFileCount = 88

$serverBaselineName =
  'nantong-business-optimization-hotfix-20260723-094404.zip'
$serverBaselinePath = Join-Path $repoRoot "release/$serverBaselineName"
$serverBaselineSha256 =
  '2C303B1DDEDCB43B8E2E3470B2BB4533204A41CEA8E4CB596C94916F2188D48C'
$purchaseBaselineName =
  'purchase-supply-chain-hotfix-20260723-114113.zip'
$purchaseBaselineSha256 =
  '26284F28600B91105ED3D9BDC027EFD337D63D1CC0F1BBA6A09D2A60DB998BAF'

$serverFiles = @(
  [ordered]@{
    path = 'dist/server/modules/duty-schedule/construction-management.js'
    baselineSha256 =
      '9FC0198D75ABC6CA74C39B4BBB2C8D87C6BE9CBAA0F262DD777FA9179C206DA7'
    currentSha256 =
      'CA66DCD4F54541A3FF3070D6D789BF6E06597CA294E115B16A23A0387943FF59'
  },
  [ordered]@{
    path = 'dist/server/modules/duty-schedule/duty-schedule.service.js'
    baselineSha256 =
      'E61957E374B28341CCD7AC2930A5B09C5E7F513FD8EFD0A534FF738D98153550'
    currentSha256 =
      'F6DBC59C37876145B50F0F04FA6F96CAD6DB3D36183D2AF0AF56F71B50716C7B'
  }
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
    throw "Required payload file is missing: $Source"
  }
  $destinationParent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
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

foreach ($path in @(
    $stageDir,
    $zipPath,
    $sidecarPath,
    $clientExtractDir,
    $serverExtractDir
  )) {
  Assert-ChildPath -Parent $outputRoot -Child $path
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach ($target in @(
    $stageDir,
    $zipPath,
    $sidecarPath,
    $clientExtractDir,
    $serverExtractDir
  )) {
  if (Test-Path -LiteralPath $target) {
    throw "Hotfix output already exists: $target"
  }
}

Assert-FileHash `
  -Path $clientBaselinePath `
  -ExpectedSha256 $clientBaselineSha256
Assert-FileHash `
  -Path $serverBaselinePath `
  -ExpectedSha256 $serverBaselineSha256
if (!(Test-Path -LiteralPath $installerSource -PathType Leaf)) {
  throw "Hotfix installer is missing: $installerSource"
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

Assert-FileHash `
  -Path (Join-Path $repoRoot $currentClientChunkPath) `
  -ExpectedSha256 $currentClientChunkSha256
foreach ($serverFile in $serverFiles) {
  Assert-FileHash `
    -Path (Join-Path $repoRoot $serverFile.path) `
    -ExpectedSha256 $serverFile.currentSha256
}

$sourceRevision = (& git rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or !$sourceRevision) {
  $sourceRevision = 'unknown'
} else {
  $sourceRevision = $sourceRevision.Trim()
}
$sourceWorktreeDirty = [bool](& git status --porcelain 2>$null)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveHash = $null
try {
  New-Item -ItemType Directory -Path $clientExtractDir | Out-Null
  New-Item -ItemType Directory -Path $serverExtractDir | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory(
    $clientBaselinePath,
    $clientExtractDir
  )
  [System.IO.Compression.ZipFile]::ExtractToDirectory(
    $serverBaselinePath,
    $serverExtractDir
  )

  $baselineClientRoot = Join-Path $clientExtractDir 'dist/client'
  $baselineMainPath = Join-Path $baselineClientRoot 'main.js'
  $baselineChunkPath = Join-Path $clientExtractDir $clientBaselineChunkPath
  if (!(Test-Path -LiteralPath $baselineClientRoot -PathType Container)) {
    throw "Client baseline directory is missing: $baselineClientRoot"
  }
  Assert-FileHash `
    -Path $baselineMainPath `
    -ExpectedSha256 $clientBaselineMainSha256
  Assert-FileHash `
    -Path $baselineChunkPath `
    -ExpectedSha256 $clientBaselineChunkSha256
  foreach ($serverFile in $serverFiles) {
    Assert-FileHash `
      -Path (Join-Path $serverExtractDir $serverFile.path) `
      -ExpectedSha256 $serverFile.baselineSha256
  }

  $baselineClientFiles = @(Get-RelativeFiles -Root $baselineClientRoot)
  if ($baselineClientFiles.Count -ne $expectedClientFileCount) {
    throw (
      "Client baseline file count mismatch. Expected " +
      "$expectedClientFileCount, got $($baselineClientFiles.Count)."
    )
  }

  New-Item -ItemType Directory -Path $stageDir | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stageDir 'dist') |
    Out-Null
  Copy-Item `
    -LiteralPath $baselineClientRoot `
    -Destination (Join-Path $stageDir 'dist/client') `
    -Recurse `
    -Force

  $stagedOldChunkPath = Join-Path $stageDir $clientBaselineChunkPath
  Assert-FileHash `
    -Path $stagedOldChunkPath `
    -ExpectedSha256 $clientBaselineChunkSha256
  Remove-Item -LiteralPath $stagedOldChunkPath -Force
  Copy-RequiredFile `
    -Source (Join-Path $repoRoot $currentClientChunkPath) `
    -Destination (Join-Path $stageDir $currentClientChunkPath)

  $stagedMainPath = Join-Path $stageDir 'dist/client/main.js'
  $mainSource = [IO.File]::ReadAllText($stagedMainPath)
  $oldMapping = "3668:`"$clientBaselineAssetHash`""
  $newMapping = "3668:`"$currentClientAssetHash`""
  $mappingMatches = [regex]::Matches(
    $mainSource,
    [regex]::Escape($oldMapping)
  )
  if ($mappingMatches.Count -ne 1) {
    throw (
      "Expected exactly one construction chunk mapping in baseline " +
      "main.js, got $($mappingMatches.Count)."
    )
  }
  $mainSource = $mainSource.Replace($oldMapping, $newMapping)
  [IO.File]::WriteAllText(
    $stagedMainPath,
    $mainSource,
    [Text.UTF8Encoding]::new($false)
  )

  foreach ($serverFile in $serverFiles) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $serverFile.path) `
      -Destination (Join-Path $stageDir $serverFile.path)
  }
  Copy-RequiredFile `
    -Source $installerSource `
    -Destination (Join-Path $stageDir $installerName)

  $stageClientRoot = Join-Path $stageDir 'dist/client'
  $stageClientFiles = @(Get-RelativeFiles -Root $stageClientRoot)
  if ($stageClientFiles.Count -ne $expectedClientFileCount) {
    throw (
      "Staged client file count mismatch. Expected " +
      "$expectedClientFileCount, got $($stageClientFiles.Count)."
    )
  }
  if (Test-Path -LiteralPath $stagedOldChunkPath) {
    throw 'Staged client still contains the obsolete construction chunk.'
  }
  Assert-FileHash `
    -Path (Join-Path $stageDir $currentClientChunkPath) `
    -ExpectedSha256 $currentClientChunkSha256
  $stagedMainSource = [IO.File]::ReadAllText($stagedMainPath)
  if (
    !$stagedMainSource.Contains($newMapping) -or
    $stagedMainSource.Contains($oldMapping)
  ) {
    throw 'Staged client runtime does not reference the new chunk.'
  }

  $allowedChangedClientFiles = @(
    'main.js',
    $clientBaselineChunkPath.Substring('dist/client/'.Length),
    $currentClientChunkPath.Substring('dist/client/'.Length)
  )
  foreach ($relativePath in $baselineClientFiles) {
    if ($relativePath -in $allowedChangedClientFiles) {
      continue
    }
    $baselineFile = Join-Path $baselineClientRoot $relativePath
    $stagedFile = Join-Path $stageClientRoot $relativePath
    if (!(Test-Path -LiteralPath $stagedFile -PathType Leaf)) {
      throw "Staged client is missing baseline file: $relativePath"
    }
    if ((Get-Sha256 -Path $baselineFile) -ne (Get-Sha256 -Path $stagedFile)) {
      throw "Unexpected client change outside construction chunk: $relativePath"
    }
  }

  foreach ($serverFile in $serverFiles) {
    Assert-FileHash `
      -Path (Join-Path $stageDir $serverFile.path) `
      -ExpectedSha256 $serverFile.currentSha256
  }

  $readmeLines = @(
    '# Construction daily verification hotfix',
    '',
    '## Scope',
    '',
    '- Enforces work-type verification before personnel verification.',
    '- Matches personnel certificates only against persisted daily work types.',
    '- Prevents personnel submission from overwriting verified work types.',
    '- Keeps the existing certificate hard-block behavior.',
    '',
    '## Required baseline',
    '',
    "- Server baseline: $serverBaselineName",
    "- Server baseline SHA256: $serverBaselineSha256",
    "- Client baseline: $clientBaselineName",
    "- Client baseline SHA256: $clientBaselineSha256",
    "- Transitive client baseline: $purchaseBaselineName",
    "- Transitive client baseline SHA256: $purchaseBaselineSha256",
    '',
    '## Install',
    '',
    '1. Stop the application.',
    '2. Extract this ZIP to a separate staging directory.',
    '3. Run:',
    '',
    '```powershell',
    "powershell -NoProfile -ExecutionPolicy Bypass -File ./$installerName -TargetRoot 'D:\path\to\application'",
    '```',
    '',
    '4. Start the application and press Ctrl+F5 in the browser.',
    '',
    'The installer validates package hashes and the deployed baseline, creates',
    'a timestamped backup under hotfix-backups, replaces dist/client as one',
    'directory, and overwrites only the two server files in the manifest.',
    '',
    '## Verify',
    '',
    '- Open Construction Management and enter a project daily follow-up.',
    '- Step 1 must be work-type verification.',
    '- Personnel verification remains disabled until step 1 is saved.',
    '- Step 2 must use the saved daily work types for certificate matching.',
    '',
    '## Rollback',
    '',
    'Stop the application and restore dist/client plus the two server files',
    'from the backup directory printed by the installer.',
    '',
    '## Exclusions',
    '',
    'This package contains no source files, tests, source maps, .env files,',
    'secrets, certificates, data, logs, node_modules, dependency manifests,',
    'or service start/stop scripts.'
  )
  [IO.File]::WriteAllLines(
    (Join-Path $stageDir $readmeName),
    $readmeLines,
    [Text.UTF8Encoding]::new($true)
  )

  $runtimePaths = @(
    Get-RelativeFiles -Root (Join-Path $stageDir 'dist') |
      ForEach-Object { "dist/$_" }
  )
  $runtimeFiles = @(
    $runtimePaths | ForEach-Object {
      $fullPath = Join-Path $stageDir $_
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $fullPath).Length
        sha256 = Get-Sha256 -Path $fullPath
      }
    }
  )
  $newMainSha256 = Get-Sha256 -Path $stagedMainPath

  $manifest = [ordered]@{
    schemaVersion = 1
    packageType =
      'construction-daily-verification-minimal-compiled-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    sourceRevision = $sourceRevision
    sourceWorktreeDirty = $sourceWorktreeDirty
    buildCommand = if ($SkipBuild) {
      'prevalidated dist; packaging invoked with -SkipBuild'
    } else {
      'npm run build:prod'
    }
    requiredPackages = @(
      [ordered]@{
        file = $serverBaselineName
        sha256 = $serverBaselineSha256
      },
      [ordered]@{
        file = $purchaseBaselineName
        sha256 = $purchaseBaselineSha256
      },
      [ordered]@{
        file = $clientBaselineName
        sha256 = $clientBaselineSha256
      }
    )
    baselines = [ordered]@{
      client = [ordered]@{
        package = $clientBaselineName
        packageSha256 = $clientBaselineSha256
        mainPath = 'dist/client/main.js'
        mainSha256 = $clientBaselineMainSha256
        constructionChunkPath = $clientBaselineChunkPath
        constructionChunkSha256 = $clientBaselineChunkSha256
      }
      server = [ordered]@{
        package = $serverBaselineName
        packageSha256 = $serverBaselineSha256
        files = @(
          $serverFiles | ForEach-Object {
            [ordered]@{
              path = $_.path
              sha256 = $_.baselineSha256
            }
          }
        )
      }
    }
    clientAssembly = [ordered]@{
      baselineFileCount = $expectedClientFileCount
      unchangedBaselineFiles = $expectedClientFileCount - 2
      replacedLogicalAsset = 'dist/client/chunks/3668.js'
      oldChunkPath = $clientBaselineChunkPath
      newChunkPath = $currentClientChunkPath
      newChunkSha256 = $currentClientChunkSha256
      newMainSha256 = $newMainSha256
    }
    replaceDirectories = @('dist/client')
    replaceFiles = @($serverFiles | ForEach-Object { $_.path })
    scope = @(
      'construction-daily-work-type-verification-first',
      'construction-daily-personnel-verification-second',
      'persisted-work-type-certificate-matching',
      'daily-work-type-overwrite-protection'
    )
    dependencyInstallRequired = $false
    secretsIncluded = $false
    files = $runtimeFiles
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 9
  [IO.File]::WriteAllText(
    (Join-Path $stageDir $manifestName),
    $manifestJson,
    [Text.UTF8Encoding]::new($true)
  )

  $actualFiles = @(Get-RelativeFiles -Root $stageDir)
  $expectedFiles = @(
    $runtimePaths +
      $installerName +
      $readmeName +
      $manifestName |
      Sort-Object
  )
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  $forbiddenFiles = @(
    $actualFiles | Where-Object {
      $_ -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|sourcemaps)(/|$)' -or
      $_ -match '\.(map|ts|tsx|d\.ts|spec|log|pem|key)$' -or
      $_ -in @('package.json', 'package-lock.json')
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Refusing to package reparse point: $($reparsePoints[0].FullName)"
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $runtimeHashes = @{}
  foreach ($file in $runtimeFiles) {
    $runtimeHashes[$file.path] = $file.sha256
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
        $_.StartsWith('/') -or
        $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match staged hotfix files.'
    }
    foreach ($entry in $archiveEntries) {
      $relativePath = $entry.FullName.Replace('\', '/')
      if ($runtimeHashes.ContainsKey($relativePath)) {
        $entryHash = Get-ZipEntryHash -Entry $entry
        if ($entryHash -ne $runtimeHashes[$relativePath]) {
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
} finally {
  foreach ($target in @($clientExtractDir, $serverExtractDir)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item `
        -LiteralPath $target `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
}

Write-Host '[OK] Construction daily verification hotfix created.' `
  -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
