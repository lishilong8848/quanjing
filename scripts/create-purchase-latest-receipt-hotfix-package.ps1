param(
  [string]$OutputDir = 'output/hotfix'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runCode = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$packageName = "purchase-receipt-coherent-client-hotfix-$timestamp-$runCode"
$packageType = 'purchase-receipt-coherent-client-overlay'
$manifestRelativePath = 'hotfix-manifest.json'
$readmeRelativePath = 'README_PURCHASE_RECEIPT_COHERENT_CLIENT_HOTFIX.md'
$installerSourcePath = Join-Path $PSScriptRoot 'apply-purchase-latest-receipt-hotfix.ps1'
$installerRelativePath = 'apply-hotfix.ps1'
$verifierSourcePath = Join-Path $PSScriptRoot 'verify-client-asset-graph.mjs'
$verifierRelativePath = 'verify-client-asset-graph.mjs'
$clientSourceRoot = Join-Path $repoRoot 'dist/client'

$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$runRoot = Join-Path $outputRoot ".$packageName.run"
$stageDir = Join-Path $runRoot 'stage'
$verifyDir = Join-Path $runRoot 'verify'
$tempZipPath = Join-Path $runRoot "$packageName.zip"
$tempSidecarPath = "$tempZipPath.sha256.txt"
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"

$overlayRelativePaths = @(
  'dist/server/common/access/unified-access.guard.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
  'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js'
)

$serverDependencyRelativePaths = @(
  'dist/server/main.js',
  'dist/server/common/access/unified-access.service.js',
  'dist/server/common/access/unified-access.decorators.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
  'dist/server/modules/purchase-inventory/purchase-workflow.gateway.js'
)

$runtimeMarkers = [ordered]@{
  'dist/server/common/access/unified-access.guard.js' = @(
    'receipt-tasks/',
    '/receive',
    '/api/duty-schedules/sync-local-fast',
    '/api/duty-overview-screenshot/send'
  )
  'dist/server/modules/purchase-inventory/purchase-inventory.controller.js' = @(
    'getReceiptTaskStatus',
    'getWorkflowSession'
  )
  'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js' = @(
    'canReadReceiptTask',
    'receiptTaskOwner'
  )
  'dist/server/modules/purchase-inventory/purchase-workflow.rules.js' = @(
    'isSameBuildingPurchaseApplicant',
    'isSameBuildingSelfPurchaseApplicant'
  )
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFull = [IO.Path]::GetFullPath($Child)
  $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
  if (
    $childFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
    !$childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to use a path outside the intended root: $Child"
  }
}

function Convert-ToSafeRelativePath {
  param([string]$Path)

  $normalized = ([string]$Path).Replace('\', '/')
  if (
    [string]::IsNullOrWhiteSpace($normalized) -or
    [IO.Path]::IsPathRooted($normalized) -or
    $normalized.StartsWith('/') -or
    $normalized.Contains(':') -or
    $normalized.Contains('//')
  ) {
    throw "Unsafe payload path: $Path"
  }
  $segments = @($normalized.Split('/'))
  if (@($segments | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0) {
    throw "Unsafe payload path: $Path"
  }
  return $normalized
}

function Assert-UniquePaths {
  param(
    [string[]]$Paths,
    [string]$Label = 'Paths'
  )

  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in @($Paths)) {
    $normalized = Convert-ToSafeRelativePath $path
    if (!$seen.Add($normalized)) {
      throw "$Label contains a duplicate path: $normalized"
    }
  }
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$FailureMessage
  )

  Assert-UniquePaths -Paths $Actual -Label 'Actual paths'
  Assert-UniquePaths -Paths $Expected -Label 'Expected paths'
  $actualPaths = @($Actual | Sort-Object -CaseSensitive)
  $expectedPaths = @($Expected | Sort-Object -CaseSensitive)
  if ($actualPaths.Count -ne $expectedPaths.Count) {
    throw $FailureMessage
  }
  for ($index = 0; $index -lt $actualPaths.Count; $index += 1) {
    if ($actualPaths[$index] -cne $expectedPaths[$index]) {
      throw $FailureMessage
    }
  }
}

function Assert-SafePayloadPaths {
  param([string[]]$Paths)

  Assert-UniquePaths -Paths $Paths -Label 'Payload paths'
  $forbiddenNames = @(
    'package.json',
    'package-lock.json',
    'purchase-workflow-ledger.json'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.key',
    '.pfx',
    '.p12'
  )
  foreach ($path in $Paths) {
    $normalized = Convert-ToSafeRelativePath $path
    $leaf = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized)
    if (
      $normalized -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime|sourcemaps)(/|$)' -or
      $leaf -in $forbiddenNames -or
      $extension -in $forbiddenExtensions
    ) {
      throw "Refusing to package forbidden path: $normalized"
    }
  }
}

function Get-RelativeFilePaths {
  param([string]$Root)

  if (!(Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Required directory is missing: $Root"
  }
  return @(
    Get-ChildItem -LiteralPath $Root -Force -File -Recurse |
      ForEach-Object {
        Convert-ToSafeRelativePath (
          $_.FullName.Substring($Root.Length).TrimStart('\', '/')
        )
      } |
      Sort-Object -CaseSensitive
  )
}

function Assert-NoReparsePoints {
  param([string]$Root)

  $rootItem = Get-Item -LiteralPath $Root -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to package a reparse-point root: $Root"
  }
  $point = Get-ChildItem -LiteralPath $Root -Force -Recurse |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    Select-Object -First 1
  if ($point) {
    throw "Refusing to package a reparse point: $($point.FullName)"
  }
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

function New-HashEntries {
  param(
    [string]$Root,
    [string[]]$RelativePaths
  )

  Assert-UniquePaths -Paths $RelativePaths -Label 'Hash entries'
  return @(
    $RelativePaths | Sort-Object -CaseSensitive | ForEach-Object {
      $relativePath = Convert-ToSafeRelativePath $_
      $fullPath = Join-Path $Root $relativePath.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required hash input is missing: $relativePath"
      }
      [ordered]@{
        path = $relativePath
        sha256 = (
          Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
        ).Hash.ToUpperInvariant()
      }
    }
  )
}

function Convert-HashEntriesToMap {
  param([object[]]$Entries)

  $map = @{}
  foreach ($entry in $Entries) {
    $path = Convert-ToSafeRelativePath ([string]$entry.path)
    if ($map.ContainsKey($path)) {
      throw "Duplicate manifest hash entry: $path"
    }
    $hash = ([string]$entry.sha256).ToUpperInvariant()
    if ($hash -notmatch '^[0-9A-F]{64}$') {
      throw "Invalid SHA256 value for $path"
    }
    $map[$path] = $hash
  }
  return $map
}

function Assert-ExactHashEntries {
  param(
    [object[]]$Actual,
    [object[]]$Expected,
    [string]$FailureMessage
  )

  $actualMap = Convert-HashEntriesToMap -Entries $Actual
  $expectedMap = Convert-HashEntriesToMap -Entries $Expected
  if ($actualMap.Count -ne $expectedMap.Count) {
    throw $FailureMessage
  }
  foreach ($path in $expectedMap.Keys) {
    if (!$actualMap.ContainsKey($path) -or $actualMap[$path] -cne $expectedMap[$path]) {
      throw $FailureMessage
    }
  }
}

function Assert-HashEntries {
  param(
    [string]$Root,
    [object[]]$Entries,
    [string]$Label
  )

  foreach ($entry in $Entries) {
    $relativePath = Convert-ToSafeRelativePath ([string]$entry.path)
    $fullPath = Join-Path $Root $relativePath.Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "$Label file is missing: $relativePath"
    }
    $actualHash = (
      Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
    ).Hash.ToUpperInvariant()
    if ($actualHash -cne ([string]$entry.sha256).ToUpperInvariant()) {
      throw "$Label hash mismatch: $relativePath"
    }
  }
}

function Assert-ManifestHashes {
  param(
    [string]$Root,
    [object[]]$ManifestFiles
  )

  Assert-HashEntries -Root $Root -Entries $ManifestFiles -Label 'Manifest payload'
}

function Assert-CompiledRuntime {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file is missing: $RelativePath"
  }
  $content = [IO.File]::ReadAllText($fullPath, [Text.Encoding]::UTF8)
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled runtime is missing '$marker': $RelativePath"
    }
  }
}

function Assert-ClientAssetGraph {
  param(
    [string]$ClientRoot,
    [string]$VerifierPath
  )

  $report = & node $VerifierPath --root $ClientRoot --json 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Client asset graph validation failed: $($report -join ' ')"
  }
  $parsed = ($report -join [Environment]::NewLine) | ConvertFrom-Json
  if (!$parsed.ok -or @($parsed.missingAssets).Count -ne 0) {
    throw 'Client asset graph validation did not return a complete graph.'
  }
}

function Assert-ClientJavaScriptSyntax {
  param([string]$ClientRoot)

  foreach ($file in Get-ChildItem -LiteralPath $ClientRoot -Force -File -Filter '*.js' -Recurse) {
    & node --check $file.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "node --check rejected client JavaScript: $($file.FullName)"
    }
  }
}

function Assert-PowerShellSyntax {
  param([string]$Path)

  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $Path,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    throw 'PowerShell parser rejected the staged installer.'
  }
}

function Assert-ZipEntries {
  param(
    [string]$ArchivePath,
    [string[]]$ExpectedPaths
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $actualPaths = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        ForEach-Object { Convert-ToSafeRelativePath $_.FullName }
    )
  } finally {
    $archive.Dispose()
  }
  Assert-SafePayloadPaths -Paths $actualPaths
  Assert-ExactPathSet `
    -Actual $actualPaths `
    -Expected $ExpectedPaths `
    -FailureMessage 'ZIP entries do not exactly match the expected payload.'
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths,
    [object[]]$ClientSnapshotFiles,
    [object[]]$TargetPreconditions,
    [object[]]$PreservedFiles,
    [string[]]$ReplaceFiles
  )

  $files = New-HashEntries -Root $Stage -RelativePaths $PayloadPaths
  [ordered]@{
    schemaVersion = 2
    package = $packageName
    packageType = $packageType
    deploymentMode = 'coherent-client-overlay'
    serviceRestartRequired = $true
    replaceFiles = @($ReplaceFiles | Sort-Object -CaseSensitive)
    targetPreconditions = @($TargetPreconditions)
    preservedFiles = @($PreservedFiles)
    clientSnapshotFiles = @($ClientSnapshotFiles)
    files = $files
  } | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $Stage $manifestRelativePath) -Encoding UTF8
}

function Assert-NewManifest {
  param(
    [string]$Root,
    [string[]]$ExpectedPayloadPaths,
    [object[]]$ExpectedClientSnapshotFiles,
    [object[]]$ExpectedTargetPreconditions,
    [object[]]$ExpectedPreservedFiles,
    [string[]]$ExpectedReplaceFiles
  )

  $manifestPath = Join-Path $Root $manifestRelativePath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 2 -or
    [string]$manifest.package -cne $packageName -or
    [string]$manifest.packageType -cne $packageType -or
    [string]$manifest.deploymentMode -cne 'coherent-client-overlay' -or
    ![bool]$manifest.serviceRestartRequired
  ) {
    throw 'Hotfix manifest identity or deployment contract is invalid.'
  }
  Assert-ExactPathSet `
    -Actual @($manifest.replaceFiles | ForEach-Object { [string]$_ }) `
    -Expected $ExpectedReplaceFiles `
    -FailureMessage 'Hotfix replaceFiles is invalid.'
  Assert-ExactHashEntries `
    -Actual @($manifest.targetPreconditions) `
    -Expected $ExpectedTargetPreconditions `
    -FailureMessage 'Hotfix targetPreconditions are invalid.'
  Assert-ExactHashEntries `
    -Actual @($manifest.preservedFiles) `
    -Expected $ExpectedPreservedFiles `
    -FailureMessage 'Hotfix preservedFiles are invalid.'
  Assert-ExactHashEntries `
    -Actual @($manifest.clientSnapshotFiles) `
    -Expected $ExpectedClientSnapshotFiles `
    -FailureMessage 'Hotfix clientSnapshotFiles are invalid.'

  $manifestFiles = @($manifest.files)
  $manifestClientFiles = @(
    $manifestFiles | Where-Object {
      ([string]$_.path).StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  )
  Assert-ExactHashEntries `
    -Actual @($manifest.clientSnapshotFiles) `
    -Expected $manifestClientFiles `
    -FailureMessage 'Hotfix clientSnapshotFiles do not match the client payload.'
  Assert-ExactPathSet `
    -Actual @($manifestFiles | ForEach-Object { [string]$_.path }) `
    -Expected $ExpectedPayloadPaths `
    -FailureMessage 'Hotfix manifest payload is invalid.'
  Assert-ManifestHashes -Root $Root -ManifestFiles $manifestFiles
  Assert-ExactPathSet `
    -Actual (Get-RelativeFilePaths -Root $Root) `
    -Expected (@($ExpectedPayloadPaths) + @($manifestRelativePath)) `
    -FailureMessage 'Hotfix files do not exactly match the manifest.'
}

Assert-ChildPath -Parent $outputRoot -Child $runRoot
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
foreach ($requiredPath in @(
    $clientSourceRoot,
    $installerSourcePath,
    $verifierSourcePath
  )) {
  if (!(Test-Path -LiteralPath $requiredPath)) {
    throw "Required packaging input is missing: $requiredPath"
  }
}
$installerSourceHash = (
  Get-FileHash -LiteralPath $installerSourcePath -Algorithm SHA256
).Hash.ToUpperInvariant()
$verifierSourceHash = (
  Get-FileHash -LiteralPath $verifierSourcePath -Algorithm SHA256
).Hash.ToUpperInvariant()
Assert-NoReparsePoints -Root $clientSourceRoot
Assert-ClientAssetGraph `
  -ClientRoot $clientSourceRoot `
  -VerifierPath $verifierSourcePath
Assert-ClientJavaScriptSyntax -ClientRoot $clientSourceRoot

$clientLocalPaths = @(Get-RelativeFilePaths -Root $clientSourceRoot)
if ($clientLocalPaths.Count -lt 2 -or $clientLocalPaths -notcontains 'main.js') {
  throw 'Client snapshot is incomplete or is missing main.js.'
}
$clientRelativePaths = @(
  $clientLocalPaths | ForEach-Object { "dist/client/$_" }
)
$clientSnapshotFiles = New-HashEntries `
  -Root $repoRoot `
  -RelativePaths $clientRelativePaths

foreach ($relativePath in $overlayRelativePaths) {
  Assert-CompiledRuntime `
    -RelativePath $relativePath `
    -Markers @($runtimeMarkers[$relativePath])
}
$allServerPreconditionPaths = @(
  @($overlayRelativePaths) + @($serverDependencyRelativePaths)
)
Assert-UniquePaths `
  -Paths $allServerPreconditionPaths `
  -Label 'Server target preconditions'
$serverTargetPreconditions = New-HashEntries `
  -Root $repoRoot `
  -RelativePaths $allServerPreconditionPaths
$overlayPathSet = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($relativePath in $overlayRelativePaths) {
  [void]$overlayPathSet.Add($relativePath)
}
$initialOverlayEntries = @(
  $serverTargetPreconditions | Where-Object {
    $overlayPathSet.Contains([string]$_.path)
  }
)
$preservedFiles = New-HashEntries `
  -Root $repoRoot `
  -RelativePaths $serverDependencyRelativePaths
$targetPreconditions = @($serverTargetPreconditions)
$replaceFiles = @(
  @($clientRelativePaths) + @($overlayRelativePaths)
)

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $runRoot) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

$publishedZip = $false
$publishedSidecar = $false
try {
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

  foreach ($relativePath in $clientRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  foreach ($relativePath in $overlayRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  Copy-RequiredFile `
    -Source $installerSourcePath `
    -Destination (Join-Path $stageDir $installerRelativePath)
  Copy-RequiredFile `
    -Source $verifierSourcePath `
    -Destination (Join-Path $stageDir $verifierRelativePath)
  $stagedOverlayEntries = New-HashEntries `
    -Root $stageDir `
    -RelativePaths $overlayRelativePaths
  Assert-ExactHashEntries `
    -Actual $stagedOverlayEntries `
    -Expected $initialOverlayEntries `
    -FailureMessage 'Staged server payload does not match the initial snapshot.'
  $stagedInstallerPath = Join-Path $stageDir $installerRelativePath
  $stagedVerifierPath = Join-Path $stageDir $verifierRelativePath
  if (
    (Get-FileHash -LiteralPath $stagedInstallerPath -Algorithm SHA256).Hash.ToUpperInvariant() -cne $installerSourceHash -or
    (Get-FileHash -LiteralPath $stagedVerifierPath -Algorithm SHA256).Hash.ToUpperInvariant() -cne $verifierSourceHash
  ) {
    throw 'Packaging inputs changed while the hotfix was being packaged.'
  }
  Assert-PowerShellSyntax -Path $stagedInstallerPath

  $readmeLines = @(
    '# Purchase receipt coherent-client hotfix',
    '',
    'This package contains one complete audited dist/client snapshot plus four compiled purchase receipt server files.',
    'It fixes the white screen caused by copying a main.js from one build over chunks from another build.',
    '',
    'Recommended deployment:',
    '1. Extract outside the application directory.',
    '2. Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-hotfix.ps1 -AppRoot <application-root>',
    '3. The installer validates every payload hash and client asset reference before stopping the service.',
    '4. The installer backs up every replaced file, restarts the service, verifies HTTP health and the served main.js hash, and rolls back on failure.',
    '',
    'If manual copying is unavoidable, copy the entire dist directory from this package. Never copy only dist/client/main.js.',
    'No environment file, dependency, source map, business data, log, certificate, or runtime state is included.'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  Assert-NoReparsePoints -Root $stageDir
  Assert-ClientAssetGraph `
    -ClientRoot (Join-Path $stageDir 'dist/client') `
    -VerifierPath (Join-Path $stageDir $verifierRelativePath)
  Assert-ClientJavaScriptSyntax -ClientRoot (Join-Path $stageDir 'dist/client')

  $currentClientLocalPaths = @(Get-RelativeFilePaths -Root $clientSourceRoot)
  Assert-ExactPathSet `
    -Actual $currentClientLocalPaths `
    -Expected $clientLocalPaths `
    -FailureMessage 'Client files changed while the hotfix was being packaged.'
  $currentClientSnapshotFiles = New-HashEntries `
    -Root $repoRoot `
    -RelativePaths $clientRelativePaths
  Assert-ExactHashEntries `
    -Actual $currentClientSnapshotFiles `
    -Expected $clientSnapshotFiles `
    -FailureMessage 'Client hashes changed while the hotfix was being packaged.'
  $currentServerTargetPreconditions = New-HashEntries `
    -Root $repoRoot `
    -RelativePaths $allServerPreconditionPaths
  Assert-ExactHashEntries `
    -Actual $currentServerTargetPreconditions `
    -Expected $serverTargetPreconditions `
    -FailureMessage 'Packaging inputs changed while the hotfix was being packaged.'
  $currentInstallerSourceHash = (
    Get-FileHash -LiteralPath $installerSourcePath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  $currentVerifierSourceHash = (
    Get-FileHash -LiteralPath $verifierSourcePath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  if (
    $currentInstallerSourceHash -cne $installerSourceHash -or
    $currentVerifierSourceHash -cne $verifierSourceHash
  ) {
    throw 'Packaging inputs changed while the hotfix was being packaged.'
  }

  $payloadPaths = @(Get-RelativeFilePaths -Root $stageDir)
  Assert-SafePayloadPaths -Paths $payloadPaths
  Write-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $payloadPaths `
    -ClientSnapshotFiles $clientSnapshotFiles `
    -TargetPreconditions $targetPreconditions `
    -PreservedFiles $preservedFiles `
    -ReplaceFiles $replaceFiles
  Assert-NewManifest `
    -Root $stageDir `
    -ExpectedPayloadPaths $payloadPaths `
    -ExpectedClientSnapshotFiles $clientSnapshotFiles `
    -ExpectedTargetPreconditions $targetPreconditions `
    -ExpectedPreservedFiles $preservedFiles `
    -ExpectedReplaceFiles $replaceFiles

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $tempZipPath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $expectedArchivePaths = @($payloadPaths) + @($manifestRelativePath)
  Assert-ZipEntries `
    -ArchivePath $tempZipPath `
    -ExpectedPaths $expectedArchivePaths

  [IO.Compression.ZipFile]::ExtractToDirectory($tempZipPath, $verifyDir)
  Assert-NoReparsePoints -Root $verifyDir
  Assert-NewManifest `
    -Root $verifyDir `
    -ExpectedPayloadPaths $payloadPaths `
    -ExpectedClientSnapshotFiles $clientSnapshotFiles `
    -ExpectedTargetPreconditions $targetPreconditions `
    -ExpectedPreservedFiles $preservedFiles `
    -ExpectedReplaceFiles $replaceFiles
  Assert-ClientAssetGraph `
    -ClientRoot (Join-Path $verifyDir 'dist/client') `
    -VerifierPath (Join-Path $verifyDir $verifierRelativePath)

  $archiveHash = (
    Get-FileHash -LiteralPath $tempZipPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $tempSidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII

  Move-Item -LiteralPath $tempZipPath -Destination $zipPath
  $publishedZip = $true
  Move-Item -LiteralPath $tempSidecarPath -Destination $sidecarPath
  $publishedSidecar = $true

  Assert-ChildPath -Parent $outputRoot -Child $runRoot
  Remove-Item -LiteralPath $runRoot -Recurse -Force
} catch {
  if (Test-Path -LiteralPath $runRoot) {
    Assert-ChildPath -Parent $outputRoot -Child $runRoot
    Remove-Item `
      -LiteralPath $runRoot `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
  if ($publishedZip -and (Test-Path -LiteralPath $zipPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if ($publishedSidecar -and (Test-Path -LiteralPath $sidecarPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[OK] Purchase receipt coherent-client hotfix created.' -ForegroundColor Green
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
