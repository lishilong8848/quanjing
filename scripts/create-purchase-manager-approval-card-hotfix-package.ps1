param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "purchase-manager-approval-card-hotfix-$timestamp"
$packageType = 'purchase-manager-approval-card-combined-hotfix'
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$baseExtractDir = Join-Path $outputRoot ".$packageName-base"
$verifyDir = Join-Path $outputRoot ".$packageName-verify"
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"

$baseArchiveRelativePath = 'output/hotfix/purchase-single-procurement-order-hotfix-20260731-082059.zip'
$baseArchiveSha256 = '5F346ECDDF34BFD6E58824A17A40A221277F02F574B483715ABD94E51D6A8351'
$baseManifestRelativePath = 'hotfix-manifest.json'
$baseReadmeRelativePath = 'README_PURCHASE_SINGLE_PROCUREMENT_ORDER_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$readmeRelativePath = 'README_PURCHASE_MANAGER_APPROVAL_CARD_HOTFIX.md'
$preservedBaseClientPrefix = 'dist/client/'

$baseServerRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js'
)
$preservedBaseServerRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js'
)
$managerOverlayRelativePaths = @(
  'dist/server/modules/purchase-inventory/purchase-manager-approval-card.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.config.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.rules.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.service.js',
  'dist/server/modules/purchase-inventory/purchase-manager-approval.scheduler.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-callback.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
  'dist/server/scripts/reconcile-purchase-manager-approval-delivery.js'
)

$cardMarkerBase64 = @(
  '57u85ZCI6YeH6LSt',
  '5qW85qCL6Ieq6YeH',
  '6amz5Zue'
)
$rejectionMarkerBase64 = @(
  '6amz5Zue5Y6f5Zug'
)
$callbackMarkers = @(
  'form_value',
  'manager_action'
)
$managerNotificationMarkers = @(
  'manager_approval_requested',
  'manager_approval_resolved',
  'manager_approval_reopened',
  'manager_approval_attention_required',
  'manual_reconciliation'
)
$reconciliationMarkers = @(
  'verified-delivered',
  'verified-absent',
  'resolveUnknownManagerApprovalDelivery'
)

function ConvertFrom-Utf8Base64Array {
  param([string[]]$Values)

  return @(
    $Values | ForEach-Object {
      [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))
    }
  )
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentFullPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFullPath = [IO.Path]::GetFullPath($Child)
  $parentPrefix = $parentFullPath + [IO.Path]::DirectorySeparatorChar
  if (
    $childFullPath.Equals(
      $parentFullPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    !$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Assert-SafePayloadPaths {
  param([string[]]$Paths)

  $forbiddenPathFragments = @(
    '/node_modules/',
    '/data/',
    '/logs/',
    '/certs/',
    '/secrets/',
    '/.runtime/',
    '/sourcemaps/',
    '/src/',
    '/source/',
    '/test/',
    '/tests/'
  )
  $forbiddenFileNames = @(
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.cer',
    '.crt',
    '.cert',
    '.key',
    '.pfx',
    '.p12'
  )
  $regexOptions =
    [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
    [Text.RegularExpressions.RegexOptions]::CultureInvariant

  foreach ($path in $Paths) {
    $rawNormalized = ([string]$path).Replace('\', '/')
    $normalized = $rawNormalized.TrimStart('/')
    $guardPath = "/$normalized/"
    $leafName = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized)
    $isUnsafeRoot = [IO.Path]::IsPathRooted([string]$path) -or
      $rawNormalized.StartsWith('/')
    $hasForbiddenPathFragment = @(
      $forbiddenPathFragments |
        Where-Object {
          $guardPath.IndexOf(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          ) -ge 0
        }
    ).Count -gt 0
    $hasForbiddenFileName = @(
      $forbiddenFileNames |
        Where-Object {
          $leafName.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasForbiddenExtension = @(
      $forbiddenExtensions |
        Where-Object {
          $extension.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasEnvironmentSegment = [Text.RegularExpressions.Regex]::IsMatch(
      $normalized,
      '(^|/)\.env[^/]*(/|$)',
      $regexOptions
    )
    $hasSpecFileName = [Text.RegularExpressions.Regex]::IsMatch(
      $leafName,
      '(^|[.])spec([.]|$)',
      $regexOptions
    )
    if (
      [string]::IsNullOrWhiteSpace([string]$path) -or
      $isUnsafeRoot -or
      $normalized -match '(^|/)\.\.?(/|$)' -or
      $hasEnvironmentSegment -or
      $hasForbiddenPathFragment -or
      $hasForbiddenFileName -or
      $hasSpecFileName -or
      $hasForbiddenExtension
    ) {
      throw "Refusing to package forbidden path: $path"
    }
  }
}

function Assert-NoReparsePoints {
  param([string]$Root)

  if (!(Test-Path -LiteralPath $Root)) {
    throw "Required payload path was not found: $Root"
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  $items = @($rootItem)
  if ($rootItem.PSIsContainer) {
    $items += @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  }
  $reparsePoint = @(
    $items |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  ) | Select-Object -First 1
  if ($reparsePoint) {
    throw "Refusing to package a reparse point: $($reparsePoint.FullName)"
  }
}

function Assert-UniquePaths {
  param(
    [string[]]$Paths,
    [string]$FailureMessage
  )

  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $Paths) {
    if (!$seen.Add(([string]$path).Replace('\', '/'))) {
      throw $FailureMessage
    }
  }
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$FailureMessage
  )

  Assert-UniquePaths -Paths $Actual -FailureMessage $FailureMessage
  Assert-UniquePaths -Paths $Expected -FailureMessage $FailureMessage
  $actualPaths = @($Actual | Sort-Object -CaseSensitive)
  $expectedPaths = @($Expected | Sort-Object -CaseSensitive)
  $difference = @(
    Compare-Object `
      -ReferenceObject $expectedPaths `
      -DifferenceObject $actualPaths `
      -CaseSensitive
  )
  if ($difference.Count -gt 0) {
    throw $FailureMessage
  }
}

function Get-StageRelativePaths {
  param([string]$Stage)

  $stageFullPath = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($stageFullPath.Length)
        $relative = $relative.TrimStart('\', '/')
        $relative.Replace('\', '/')
      } |
      Sort-Object -CaseSensitive
  )
}

function Get-UniqueSortedPaths {
  param([string[]]$Paths)

  return @(
    $Paths |
      ForEach-Object { ([string]$_).Replace('\', '/') } |
      Sort-Object -Unique -CaseSensitive
  )
}

function Assert-BaseArchiveHash {
  param([string]$ArchivePath)

  if (!(Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "Frozen base archive was not found: $ArchivePath"
  }
  $actualHash = (
    Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  if ($actualHash -ne $baseArchiveSha256) {
    throw 'Base archive SHA256 mismatch.'
  }
}

function Assert-SafeArchiveEntries {
  param([System.IO.Compression.ZipArchive]$Archive)

  $allPaths = @(
    $Archive.Entries |
      Where-Object { $_.FullName } |
      ForEach-Object { $_.FullName.Replace('\', '/') }
  )
  try {
    Assert-SafePayloadPaths -Paths $allPaths
  } catch {
    throw 'ZIP contains an unsafe entry path.'
  }
  Assert-UniquePaths `
    -Paths $allPaths `
    -FailureMessage 'ZIP contains duplicate entry paths.'
  return @(
    $Archive.Entries |
      Where-Object { $_.Name } |
      ForEach-Object { $_.FullName.Replace('\', '/') } |
      Sort-Object -CaseSensitive
  )
}

function Expand-VerifiedBaseArchive {
  param(
    [string]$ArchivePath,
    [string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $filePaths = Assert-SafeArchiveEntries -Archive $archive
  } finally {
    $archive.Dispose()
  }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory(
    $ArchivePath,
    $Destination
  )
  Assert-NoReparsePoints -Root $Destination
  return @($filePaths)
}

function Assert-ManifestFileHashes {
  param(
    [string]$Root,
    [object[]]$ManifestFiles,
    [string]$HashMismatchPrefix
  )

  $manifestPaths = @(
    $ManifestFiles | ForEach-Object { [string]$_.path }
  )
  Assert-SafePayloadPaths -Paths $manifestPaths
  Assert-UniquePaths `
    -Paths $manifestPaths `
    -FailureMessage 'Manifest contains duplicate file paths.'
  foreach ($entry in $ManifestFiles) {
    $relativePath = [string]$entry.path
    $expectedHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($expectedHash -notmatch '^[A-F0-9]{64}$') {
      throw "Manifest contains an invalid SHA256: $relativePath"
    }
    $fullPath = Join-Path $Root $relativePath.Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Manifest payload is missing: $relativePath"
    }
    $actualHash = (
      Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
    ).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "$HashMismatchPrefix $relativePath"
    }
  }
}

function Assert-BaseManifest {
  param(
    [string]$ExtractedRoot,
    [string[]]$ArchiveFilePaths
  )

  $manifestPath = Join-Path $ExtractedRoot $baseManifestRelativePath
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Frozen base archive does not contain hotfix-manifest.json.'
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 1 -or
    [string]$manifest.package -ne
      'purchase-single-procurement-order-hotfix-20260731-082059' -or
    [string]$manifest.packageType -ne
      'purchase-single-procurement-order-hotfix'
  ) {
    throw 'Frozen base manifest identity is invalid.'
  }
  Assert-ExactPathSet `
    -Actual @($manifest.replaceDirectories | ForEach-Object { [string]$_ }) `
    -Expected @('dist/client') `
    -FailureMessage 'Frozen base replaceDirectories is invalid.'
  Assert-ExactPathSet `
    -Actual @($manifest.replaceFiles | ForEach-Object { [string]$_ }) `
    -Expected $baseServerRelativePaths `
    -FailureMessage 'Frozen base replaceFiles is invalid.'

  $manifestFiles = @($manifest.files)
  $manifestPaths = @(
    $manifestFiles | ForEach-Object { [string]$_.path }
  )
  $expectedArchivePaths = @($manifestPaths) + @($baseManifestRelativePath)
  Assert-ExactPathSet `
    -Actual $ArchiveFilePaths `
    -Expected $expectedArchivePaths `
    -FailureMessage 'Base manifest entries do not exactly match the frozen archive.'
  Assert-ManifestFileHashes `
    -Root $ExtractedRoot `
    -ManifestFiles $manifestFiles `
    -HashMismatchPrefix 'Base manifest hash mismatch:'

  if (
    $baseReadmeRelativePath -notin $manifestPaths -or
    @(
      $manifestPaths |
        Where-Object { $_.StartsWith($preservedBaseClientPrefix) }
    ).Count -eq 0
  ) {
    throw 'Frozen base manifest is missing its README or complete client tree.'
  }
  return $manifest
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
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-VerifiedBaseManifestPayload {
  param(
    [string]$ExtractedRoot,
    [string]$Stage,
    [object]$BaseManifest
  )

  foreach ($entry in @($BaseManifest.files)) {
    $relativePath = [string]$entry.path
    if ($relativePath -eq $baseReadmeRelativePath) {
      continue
    }
    Copy-RequiredFile `
      -Source (Join-Path $ExtractedRoot $relativePath) `
      -Destination (Join-Path $Stage $relativePath)
  }
}

function Assert-PreservedBaseManifestEntries {
  param(
    [string]$Stage,
    [object]$BaseManifest
  )

  $preservedEntries = @(
    @($BaseManifest.files) |
      Where-Object {
        $path = [string]$_.path
        $path.StartsWith($preservedBaseClientPrefix) -or
          $path -in $preservedBaseServerRelativePaths
      }
  )
  if ($preservedEntries.Count -eq 0) {
    throw 'No frozen base client entries were selected for preservation.'
  }
  Assert-ManifestFileHashes `
    -Root $Stage `
    -ManifestFiles $preservedEntries `
    -HashMismatchPrefix 'Frozen base payload changed after overlay:'
}

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled server runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled server runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles
  )

  $files = @(
    $PayloadPaths | Sort-Object -CaseSensitive | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
      [ordered]@{
        path = $_
        sha256 = $fileHash.Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = $packageName
    packageType = $packageType
    baseArchive = $baseArchiveRelativePath
    baseArchiveSha256 = $baseArchiveSha256
    replaceDirectories = @('dist/client')
    replaceFiles = @($ReplaceFiles)
    files = $files
  } | ConvertTo-Json -Depth 6 |
    Set-Content `
      -LiteralPath (Join-Path $Stage $manifestRelativePath) `
      -Encoding UTF8
}

function Assert-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles,
    [string]$HashMismatchPrefix = 'Hotfix manifest hash mismatch:'
  )

  $manifestPath = Join-Path $Stage $manifestRelativePath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 1 -or
    [string]$manifest.package -cne $packageName -or
    [string]$manifest.packageType -ne $packageType -or
    [string]$manifest.baseArchive -cne $baseArchiveRelativePath -or
    [string]$manifest.baseArchiveSha256 -ne $baseArchiveSha256
  ) {
    throw 'Combined hotfix manifest identity is invalid.'
  }
  Assert-ExactPathSet `
    -Actual @($manifest.replaceDirectories | ForEach-Object { [string]$_ }) `
    -Expected @('dist/client') `
    -FailureMessage 'Combined manifest replaceDirectories is invalid.'
  Assert-ExactPathSet `
    -Actual @($manifest.replaceFiles | ForEach-Object { [string]$_ }) `
    -Expected $ReplaceFiles `
    -FailureMessage 'Combined manifest replaceFiles is invalid.'
  $manifestFiles = @($manifest.files)
  Assert-ExactPathSet `
    -Actual @($manifestFiles | ForEach-Object { [string]$_.path }) `
    -Expected $PayloadPaths `
    -FailureMessage 'Combined manifest entries do not match the payload files.'
  Assert-ManifestFileHashes `
    -Root $Stage `
    -ManifestFiles $manifestFiles `
    -HashMismatchPrefix $HashMismatchPrefix
}

function Assert-ZipSidecar {
  param(
    [string]$ArchivePath,
    [string]$SidecarPath
  )

  if (
    !(Test-Path -LiteralPath $ArchivePath -PathType Leaf) -or
    !(Test-Path -LiteralPath $SidecarPath -PathType Leaf)
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
  $rawSidecar = Get-Content -Raw -LiteralPath $SidecarPath -Encoding ASCII
  $sidecarValue = $rawSidecar.TrimEnd([char[]]"`r`n")
  $sidecarMatch = [Text.RegularExpressions.Regex]::Match(
    $sidecarValue,
    '^(?<hash>[A-Fa-f0-9]{64})  (?<file>[^/\\\r\n]+)$',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  $expectedFileName = [IO.Path]::GetFileName($ArchivePath)
  if (
    !$sidecarMatch.Success -or
    !$sidecarMatch.Groups['file'].Value.Equals(
      $expectedFileName,
      [StringComparison]::Ordinal
    )
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
  $expectedHash = $sidecarMatch.Groups['hash'].Value.ToUpperInvariant()
  $actualHash = (
    Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
}

function Verify-FinalArchive {
  param(
    [string]$zipPath,
    [string]$VerificationRoot,
    [string[]]$PayloadPaths,
    [string[]]$ReplaceFiles
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archivePaths = Assert-SafeArchiveEntries -Archive $archive
    Assert-ExactPathSet `
      -Actual $archivePaths `
      -Expected (@($PayloadPaths) + @($manifestRelativePath)) `
      -FailureMessage 'Final ZIP entries do not exactly match the manifest and metadata files.'
  } finally {
    $archive.Dispose()
  }

  New-Item -ItemType Directory -Path $VerificationRoot | Out-Null
  try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory(
      $zipPath,
      $VerificationRoot
    )
    Assert-NoReparsePoints -Root $VerificationRoot
    Assert-HotfixManifest `
      -Stage $VerificationRoot `
      -PayloadPaths $PayloadPaths `
      -ReplaceFiles $ReplaceFiles `
      -HashMismatchPrefix 'Final archive manifest hash mismatch:'
    $verifiedPaths = Get-StageRelativePaths -Stage $VerificationRoot
    Assert-ExactPathSet `
      -Actual $verifiedPaths `
      -Expected (@($PayloadPaths) + @($manifestRelativePath)) `
      -FailureMessage 'Final ZIP extraction contains an unexpected or missing file.'
  } finally {
    if (Test-Path -LiteralPath $VerificationRoot) {
      Remove-Item -LiteralPath $VerificationRoot -Recurse -Force
    }
  }
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Production server build failed; hotfix package was not created.'
  }
}

$baseArchivePath = Join-Path $repoRoot $baseArchiveRelativePath
Assert-BaseArchiveHash -ArchivePath $baseArchivePath

$decodedCardMarkers = ConvertFrom-Utf8Base64Array -Values $cardMarkerBase64
$decodedRejectionMarkers = ConvertFrom-Utf8Base64Array `
  -Values $rejectionMarkerBase64
Assert-CompiledFileContains `
  -RelativePath $managerOverlayRelativePaths[0] `
  -Markers $decodedCardMarkers
Assert-CompiledFileContains `
  -RelativePath $managerOverlayRelativePaths[2] `
  -Markers $decodedRejectionMarkers
Assert-CompiledFileContains `
  -RelativePath $managerOverlayRelativePaths[6] `
  -Markers $callbackMarkers
Assert-CompiledFileContains `
  -RelativePath $managerOverlayRelativePaths[8] `
  -Markers $managerNotificationMarkers
Assert-CompiledFileContains `
  -RelativePath $managerOverlayRelativePaths[11] `
  -Markers $reconciliationMarkers

foreach ($compiledRelativePath in $managerOverlayRelativePaths) {
  Assert-NoReparsePoints -Root (Join-Path $repoRoot $compiledRelativePath)
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $baseExtractDir
Assert-ChildPath -Parent $outputRoot -Child $verifyDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
foreach (
  $claimedPath in @(
    $stageDir,
    $baseExtractDir,
    $verifyDir,
    $zipPath,
    $sidecarPath
  )
) {
  if (Test-Path -LiteralPath $claimedPath) {
    throw "Hotfix output already exists: $claimedPath"
  }
}

$stageCreated = $false
$archiveHash = ''
try {
  $baseArchiveFilePaths = Expand-VerifiedBaseArchive -ArchivePath $baseArchivePath `
    -Destination $baseExtractDir
  $baseManifest = Assert-BaseManifest -ExtractedRoot $baseExtractDir `
    -ArchiveFilePaths $baseArchiveFilePaths

  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stageCreated = $true
  Copy-VerifiedBaseManifestPayload -ExtractedRoot $baseExtractDir `
    -Stage $stageDir `
    -BaseManifest $baseManifest

  foreach ($relativePath in $managerOverlayRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  Assert-PreservedBaseManifestEntries -Stage $stageDir `
    -BaseManifest $baseManifest

  $finalServerRelativePaths = Get-UniqueSortedPaths `
    -Paths (@($baseServerRelativePaths) + @($managerOverlayRelativePaths))
  $readmeLines = @(
    '# Purchase manager approval card combined hotfix',
    '',
    '## Provenance',
    '',
    "- Frozen base: ``$baseArchiveRelativePath``",
    "- Frozen base SHA256: ``$baseArchiveSha256``",
    '- The complete `dist/client`, purchase validation, and purchase mapper come only from the verified frozen base archive.',
    '- The current workspace `dist/client` is never copied.',
    '- The manager approval feature overlays only the server runtime files listed below.',
    '',
    '## Safe deployment order',
    '',
    '1. Keep `PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=false` and `PURCHASE_WORKFLOW_PROGRAM_ENABLED=false`.',
    '2. Stop the application and back up the complete deployed `dist/client`, all listed server files, and the purchase workflow ledger.',
    '3. Extract this ZIP into the application root and replace the complete `dist/client` plus the listed server files.',
    '4. Start the application and validate the Feishu callback plus the unique manager configuration while the new feature remains disabled.',
    '5. Pause purchase submissions and stop the application before switching approval ownership.',
    '6. While the application remains stopped, disable only the duplicate Feishu Base manager-approval action and set `PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=true`.',
    '7. Start the application and submit one controlled request.',
    '8. Audit the recorded transition window and reconcile every waiting approval before resuming submissions.',
    '',
    '## Server runtime files'
  ) + @(
    $finalServerRelativePaths | ForEach-Object { '- `' + $_ + '`' }
  ) + @(
    '',
    '## Rollback',
    '',
    'Keep purchase submissions paused throughout rollback.',
    'Stop the application first; while it remains stopped, disable the manager-card flag, re-enable the duplicate Base manager-approval action, and restore only the backed-up client and server files.',
    'Audit the recorded transition window and reconcile every waiting approval before resuming submissions.',
    'Remove listed manager-card or reconciliation CLI files that did not exist before deployment.',
    'Do not restore an older ledger over approvals that already occurred.',
    'Restart and verify with `PURCHASE_WORKFLOW_PROGRAM_ENABLED=false`.',
    '',
    '## Delivery unknown',
    '',
    'Stop the application, back up the ledger, inspect the manager conversation, and use the packaged reconciliation CLI in `verified-delivered` or `verified-absent` mode. Never edit the live ledger directly.',
    '',
    '## Exclusions',
    '',
    'This package contains no source files, source maps, tests, secrets, dependencies, dependency manifests, environment files, business data, logs, certificates, or runtime state.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $basePayloadPaths = @(
    @($baseManifest.files) |
      ForEach-Object { [string]$_.path } |
      Where-Object { $_ -ne $baseReadmeRelativePath }
  )
  $expectedPayloadPaths = Get-UniqueSortedPaths `
    -Paths (
      @($basePayloadPaths) +
      @($managerOverlayRelativePaths) +
      @($readmeRelativePath)
    )
  $stagedPayloadPaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $stagedPayloadPaths `
    -Expected $expectedPayloadPaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $stagedPayloadPaths
  Assert-NoReparsePoints -Root $stageDir

  Write-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths
  Assert-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths

  $actualStagePaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $actualStagePaths `
    -Expected (@($stagedPayloadPaths) + @($manifestRelativePath)) `
    -FailureMessage 'Hotfix staging contains an unexpected or missing metadata file.'
  Assert-SafePayloadPaths -Paths $actualStagePaths

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  Verify-FinalArchive `
    -zipPath $zipPath `
    -VerificationRoot $verifyDir `
    -PayloadPaths $stagedPayloadPaths `
    -ReplaceFiles $finalServerRelativePaths

  $archiveHash = (
    Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  $sidecarValue = "$archiveHash  $([IO.Path]::GetFileName($zipPath))"
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value $sidecarValue `
    -Encoding ASCII
  Assert-ZipSidecar -ArchivePath $zipPath -SidecarPath $sidecarPath
} catch {
  if ($stageCreated -and (Test-Path -LiteralPath $stageDir)) {
    Assert-ChildPath -Parent $outputRoot -Child $stageDir
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $zipPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $sidecarPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  foreach ($temporaryPath in @($baseExtractDir, $verifyDir)) {
    if (Test-Path -LiteralPath $temporaryPath) {
      Assert-ChildPath -Parent $outputRoot -Child $temporaryPath
      Remove-Item `
        -LiteralPath $temporaryPath `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
}

Write-Host '[OK] Purchase manager approval combined hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
