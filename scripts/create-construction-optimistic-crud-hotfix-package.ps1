param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "construction-optimistic-crud-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientExtractDir = Join-Path $outputRoot (
  ".construction-optimistic-client-baseline-$timestamp-$PID"
)
$serverExtractDir = Join-Path $outputRoot (
  ".construction-optimistic-server-baseline-$timestamp-$PID"
)
$roundTripMainPath = Join-Path $outputRoot (
  ".construction-optimistic-main-roundtrip-$timestamp-$PID.js"
)

$manifestName = 'hotfix-manifest.json'
$readmeName = 'README_CONSTRUCTION_OPTIMISTIC_CRUD.md'
$installerName = 'apply-construction-optimistic-crud-hotfix.ps1'
$installerSource = Join-Path $repoRoot "deploy/$installerName"
$readmeSource = Join-Path $repoRoot "deploy/$readmeName"
$moduleReplacerSource = Join-Path $repoRoot (
  'scripts/replace-rspack-main-module.mjs'
)
$assetNormalizerSource = Join-Path $repoRoot (
  'scripts/normalize-client-build-asset.mjs'
)

$clientBaselineName =
  'construction-daily-verification-hotfix-20260723-175514.zip'
$clientBaselinePath = Join-Path $repoRoot (
  "output/hotfix/$clientBaselineName"
)
$clientBaselineSha256 =
  '6B4EB59BF9DC0C5B255981A93368D3F0156164B1D4E7455120C8EC026A314C95'
$clientBaselineMainSha256 =
  '935F9EA63A57E203764E532B88C807AF311A1E41A07D460B41879A30C695DC98'
$clientBaselineChunkPath = 'dist/client/chunks/3668.c99500bd.js'
$clientBaselineChunkSha256 =
  'CF455AF2DEDBC3582BED68CF2DD658D44C4E4E2AC5824178FE5729E76B1DED23'
$clientBaselineModuleSha256 =
  '0BA93E03855EC487E1CDD00C815FC5A3FD125F421E8D29F2A26B59880FEDA200'
$clientBaselineAssetHash = 'c99500bd'
$currentClientChunkNormalizedSha256 =
  'CB35C1C2C68EB8285D93233B013C5FE1CF6DCFF263B23B9248AB29513E69D0DE'
$currentClientModuleSha256 =
  '17589DF87086669D9A32086FCB65BC47929462274A6A33FE95D4C9FDF061D040'
$currentServerSha256 =
  '60F7D52756445C38D30B510CD6640C4A460581B80B9FAF920A01D8B0718F80F4'
$moduleId = '79636'
$chunkId = '3668'
$expectedClientFileCount = 88

$serverBaselineName =
  'construction-work-type-submit-hotfix-20260724-074957.zip'
$serverBaselinePath = Join-Path $repoRoot (
  "output/hotfix/$serverBaselineName"
)
$serverBaselineSha256 =
  'E67DA91185444F9F536E6AD174010AFD4011FBBFBE295D0FDF25404E8F02CD82'
$serverRelativePath =
  'dist/server/modules/duty-schedule/duty-schedule.service.js'
$serverBaselineFileSha256 =
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

function Assert-FinalizedConstant {
  param(
    [string]$Name,
    [string]$Value,
    [ValidateSet('hash', 'assetHash', 'path')]
    [string]$Kind
  )

  if ($Value -like 'PENDING_FINAL_BUILD_*') {
    throw (
      "$Name must be finalized before packaging. Run the final production " +
      'build, verify the compiled artifact, and replace the explicit ' +
      'PENDING_FINAL_BUILD_ placeholder.'
    )
  }
  switch ($Kind) {
    'hash' {
      if ($Value -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "$Name must be a 64-character SHA256 value."
      }
    }
    'assetHash' {
      if ($Value -notmatch '^[A-Fa-f0-9]{8,64}$') {
        throw "$Name must be an 8-64 character hexadecimal asset hash."
      }
    }
    'path' {
      if (
        $Value -notmatch
          '^dist/client/chunks/3668\.[A-Fa-f0-9]{8,64}\.js$'
      ) {
        throw "$Name must identify the compiled construction chunk."
      }
    }
  }
}

function Assert-ZipEntriesSafe {
  param(
    [System.IO.Compression.ZipArchive]$Archive,
    [string]$Label
  )

  $entryNames = @{}
  foreach ($entry in $Archive.Entries) {
    $relativePath = $entry.FullName.Replace('\', '/')
    if (
      [string]::IsNullOrWhiteSpace($relativePath) -or
      $relativePath.StartsWith('/') -or
      [IO.Path]::IsPathRooted($relativePath) -or
      $relativePath -match '(^|/)\.\.(/|$)' -or
      $relativePath.Contains('//')
    ) {
      throw "Unsafe ZIP entry in $Label`: $relativePath"
    }
    $normalizedKey = $relativePath.TrimEnd('/').ToUpperInvariant()
    if ($entryNames.ContainsKey($normalizedKey)) {
      throw "Duplicate ZIP entry in $Label`: $relativePath"
    }
    $entryNames[$normalizedKey] = $true
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
    $serverExtractDir,
    $roundTripMainPath
  )) {
  Assert-ChildPath -Parent $outputRoot -Child $path
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach ($target in @(
    $stageDir,
    $zipPath,
    $sidecarPath,
    $clientExtractDir,
    $serverExtractDir,
    $roundTripMainPath
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
if (!(Test-Path -LiteralPath $readmeSource -PathType Leaf)) {
  throw "Hotfix README is missing: $readmeSource"
}
if (!(Test-Path -LiteralPath $moduleReplacerSource -PathType Leaf)) {
  throw "Rspack module replacer is missing: $moduleReplacerSource"
}
if (!(Test-Path -LiteralPath $assetNormalizerSource -PathType Leaf)) {
  throw "Client asset normalizer is missing: $assetNormalizerSource"
}

Assert-FinalizedConstant `
  -Name 'currentClientChunkNormalizedSha256' `
  -Value $currentClientChunkNormalizedSha256 `
  -Kind hash
Assert-FinalizedConstant `
  -Name 'currentClientModuleSha256' `
  -Value $currentClientModuleSha256 `
  -Kind hash
Assert-FinalizedConstant `
  -Name 'currentServerSha256' `
  -Value $currentServerSha256 `
  -Kind hash

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}

$currentClientChunkCandidates = @(
  Get-ChildItem `
    -LiteralPath (Join-Path $repoRoot 'dist/client/chunks') `
    -Filter "$chunkId.*.js" `
    -File
)
if ($currentClientChunkCandidates.Count -ne 1) {
  throw (
    "Expected exactly one compiled construction chunk for $chunkId, got " +
    "$($currentClientChunkCandidates.Count)."
  )
}
$currentClientChunkFile = $currentClientChunkCandidates[0]
if (
  $currentClientChunkFile.Name -notmatch
    "^$chunkId\.([A-Fa-f0-9]{8,64})\.js$"
) {
  throw (
    'Compiled construction chunk filename does not contain a valid asset ' +
    "hash: $($currentClientChunkFile.Name)"
  )
}
$currentClientAssetHash = $Matches[1]
$currentClientChunkPath =
  "dist/client/chunks/$($currentClientChunkFile.Name)"
$currentClientChunkSha256 = Get-Sha256 -Path $currentClientChunkFile.FullName
$currentMainPath = Join-Path $repoRoot 'dist/client/main.js'
if (!(Test-Path -LiteralPath $currentMainPath -PathType Leaf)) {
  throw "Required file is missing: $currentMainPath"
}
$currentClientMainSha256 = Get-Sha256 -Path $currentMainPath

Assert-FinalizedConstant `
  -Name 'currentClientChunkPath' `
  -Value $currentClientChunkPath `
  -Kind path
Assert-FinalizedConstant `
  -Name 'currentClientChunkSha256' `
  -Value $currentClientChunkSha256 `
  -Kind hash
Assert-FinalizedConstant `
  -Name 'currentClientMainSha256' `
  -Value $currentClientMainSha256 `
  -Kind hash
Assert-FinalizedConstant `
  -Name 'currentClientAssetHash' `
  -Value $currentClientAssetHash `
  -Kind assetHash
if (
  $currentClientChunkPath -eq $clientBaselineChunkPath -or
  $currentClientAssetHash -eq $clientBaselineAssetHash
) {
  throw 'The final construction chunk must differ from the client baseline.'
}

$normalizerOutput = @(
  & node `
    $assetNormalizerSource `
    --asset $currentClientChunkFile.FullName
)
if ($LASTEXITCODE -ne 0 -or $normalizerOutput.Count -ne 1) {
  throw 'Compiled construction chunk normalization failed.'
}
try {
  $normalizerReport = (
    $normalizerOutput -join [Environment]::NewLine
  ) | ConvertFrom-Json
} catch {
  throw "Client asset normalization report is invalid: $($_.Exception.Message)"
}
if (
  [string]$normalizerReport.fullSha256 -ne
    $currentClientChunkSha256 -or
  [string]$normalizerReport.normalizedSha256 -ne
    $currentClientChunkNormalizedSha256 -or
  [int]$normalizerReport.buildTimeCount -ne 1
) {
  throw (
    'Compiled construction chunk content differs from the approved build ' +
    'after normalizing its single injected build timestamp.'
  )
}

Assert-FileHash `
  -Path (Join-Path $repoRoot $currentClientChunkPath) `
  -ExpectedSha256 $currentClientChunkSha256
Assert-FileHash `
  -Path (Join-Path $repoRoot 'dist/client/main.js') `
  -ExpectedSha256 $currentClientMainSha256
Assert-FileHash `
  -Path (Join-Path $repoRoot $serverRelativePath) `
  -ExpectedSha256 $currentServerSha256

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
  $clientArchive = [System.IO.Compression.ZipFile]::OpenRead(
    $clientBaselinePath
  )
  try {
    Assert-ZipEntriesSafe `
      -Archive $clientArchive `
      -Label 'client baseline'
  } finally {
    $clientArchive.Dispose()
  }
  $serverArchive = [System.IO.Compression.ZipFile]::OpenRead(
    $serverBaselinePath
  )
  try {
    Assert-ZipEntriesSafe `
      -Archive $serverArchive `
      -Label 'server baseline'
  } finally {
    $serverArchive.Dispose()
  }
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
  Assert-FileHash `
    -Path (Join-Path $serverExtractDir $serverRelativePath) `
    -ExpectedSha256 $serverBaselineFileSha256

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
      $assemblyOutput = @(
    & node `
      $moduleReplacerSource `
      --baseline $baselineMainPath `
      --current $currentMainPath `
      --output $stagedMainPath `
      --module-id $moduleId `
      --chunk-id $chunkId `
      --baseline-chunk-hash $clientBaselineAssetHash `
      --current-chunk-hash $currentClientAssetHash `
      --expected-baseline-module-sha256 $clientBaselineModuleSha256 `
      --expected-current-module-sha256 $currentClientModuleSha256
  )
  if ($LASTEXITCODE -ne 0) {
    throw 'Rspack main.js module assembly failed.'
  }
  try {
    $assemblyReport = (
      $assemblyOutput -join [Environment]::NewLine
    ) | ConvertFrom-Json
  } catch {
    throw "Rspack assembly report is invalid: $($_.Exception.Message)"
  }
  if (
    [string]$assemblyReport.moduleId -ne $moduleId -or
    [string]$assemblyReport.chunkId -ne $chunkId -or
    [int]$assemblyReport.moduleReplacementCount -ne 1 -or
    [int]$assemblyReport.mappingReplacementCount -ne 1 -or
    [string]$assemblyReport.baselineModuleSha256 -ne
      $clientBaselineModuleSha256 -or
    [string]$assemblyReport.currentModuleSha256 -ne
      $currentClientModuleSha256
  ) {
    throw 'Rspack assembly report does not match the approved replacement.'
  }

  $roundTripOutput = @(
    & node `
      $moduleReplacerSource `
      --baseline $stagedMainPath `
      --current $baselineMainPath `
      --output $roundTripMainPath `
      --module-id $moduleId `
      --chunk-id $chunkId `
      --baseline-chunk-hash $currentClientAssetHash `
      --current-chunk-hash $clientBaselineAssetHash `
      --expected-baseline-module-sha256 $currentClientModuleSha256 `
      --expected-current-module-sha256 $clientBaselineModuleSha256
  )
  if ($LASTEXITCODE -ne 0 -or $roundTripOutput.Count -ne 1) {
    throw 'Rspack main.js round-trip verification failed.'
  }
  Assert-FileHash `
    -Path $roundTripMainPath `
    -ExpectedSha256 $clientBaselineMainSha256

  Copy-RequiredFile `
    -Source (Join-Path $repoRoot $serverRelativePath) `
    -Destination (Join-Path $stageDir $serverRelativePath)
  Copy-RequiredFile `
    -Source $installerSource `
    -Destination (Join-Path $stageDir $installerName)
  Copy-RequiredFile `
    -Source $readmeSource `
    -Destination (Join-Path $stageDir $readmeName)

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
  $newMainSha256 = Get-Sha256 -Path $stagedMainPath
  if (
    [string]$assemblyReport.outputSha256 -ne $newMainSha256
  ) {
    throw 'Staged main.js SHA256 does not match the assembly report.'
  }
  & node --check $stagedMainPath
  if ($LASTEXITCODE -ne 0) {
    throw 'Staged main.js failed the Node syntax check.'
  }
  $oldMapping = "$chunkId`:`"$clientBaselineAssetHash`""
  $newMapping = "$chunkId`:`"$currentClientAssetHash`""
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
      throw (
        'Unexpected client change outside approved files: ' +
        $relativePath
      )
    }
  }

  Assert-FileHash `
    -Path (Join-Path $stageDir $serverRelativePath) `
    -ExpectedSha256 $currentServerSha256

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
  $auxiliaryPaths = @($installerName, $readmeName)
  $auxiliaryFiles = @(
    $auxiliaryPaths | ForEach-Object {
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
      'construction-optimistic-crud-minimal-compiled-overlay'
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
        file = $clientBaselineName
        sha256 = $clientBaselineSha256
      },
      [ordered]@{
        file = $serverBaselineName
        sha256 = $serverBaselineSha256
      }
    )
    baselines = [ordered]@{
      client = [ordered]@{
        package = $clientBaselineName
        packageSha256 = $clientBaselineSha256
        mainPath = 'dist/client/main.js'
        mainSha256 = $clientBaselineMainSha256
        constructionFetchModuleId = $moduleId
        constructionFetchModuleSha256 =
          $clientBaselineModuleSha256
        constructionChunkPath = $clientBaselineChunkPath
        constructionChunkSha256 = $clientBaselineChunkSha256
      }
      server = [ordered]@{
        package = $serverBaselineName
        packageSha256 = $serverBaselineSha256
        files = @(
          [ordered]@{
            path = $serverRelativePath
            sha256 = $serverBaselineFileSha256
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
      moduleId = $moduleId
      baselineModuleSha256 = $clientBaselineModuleSha256
      currentModuleSha256 = $currentClientModuleSha256
      moduleReplacementCount = 1
      chunkMappingId = $chunkId
      chunkMappingReplacementCount = 1
      currentBuildMainSha256 = $currentClientMainSha256
    }
    replaceDirectories = @('dist/client')
    replaceFiles = @($serverRelativePath)
    scope = @(
      'construction-management-optimistic-create-update-delete',
      'construction-management-immediate-ui-feedback',
      'construction-management-failure-rollback',
      'construction-management-idempotent-followup',
      'construction-management-background-side-effects',
      'construction-management-ocr-refresh-boundary',
      'construction-management-ai-audit-master-switch-default-off',
      'construction-management-manual-review-only-mode',
      'construction-management-personnel-certificate-check-preserved',
      'construction-fetch-timeout-and-abort-composition'
    )
    dependencyInstallRequired = $false
    secretsIncluded = $false
    auxiliaryFiles = $auxiliaryFiles
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

  $payloadHashes = @{}
  foreach ($file in @($runtimeFiles) + @($auxiliaryFiles)) {
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
        $_.StartsWith('/') -or
        $_ -match '(^|/)\.\.(/|$)'
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
} finally {
  foreach ($target in @(
      $clientExtractDir,
      $serverExtractDir,
      $roundTripMainPath
    )) {
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

Write-Host '[OK] Construction optimistic CRUD hotfix created.' `
  -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] ZIP: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
