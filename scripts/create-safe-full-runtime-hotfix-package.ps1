[CmdletBinding()]
param(
  [string]$OutputRoot,
  [Parameter(Mandatory = $true)]
  [string]$BaselineRoot,
  [string]$BuildNodePath,
  [string]$BuildNpmPath,
  [string]$VerifiedProductionNodeModulesRoot,
  [string]$BuildSourceRoot,
  [switch]$ValidateBaselineOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$baselineExportRootPath = (Resolve-Path -LiteralPath $BaselineRoot).Path
$releaseToolPath = (Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
$releaseToolFingerprintAtStart = (Get-FileHash -LiteralPath $releaseToolPath -Algorithm SHA256).Hash.ToLowerInvariant()
$baselineGateToolPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'assert-current-production-baseline.ps1')).Path
$baselineGateToolFingerprintAtStart = (Get-FileHash -LiteralPath $baselineGateToolPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot 'output\hotfix'
}
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageId = "nantong-safe-full-runtime-hotfix-$timestamp"
$ownerToken = [Guid]::NewGuid().ToString('N')
$zipPath = Join-Path $outputRootPath "$packageId.zip"
$shaPath = "$zipPath.sha256"
$partialZipPath = Join-Path $outputRootPath ($packageId + '.' + $ownerToken + ".zip.partial")
$partialShaPath = Join-Path $outputRootPath ($packageId + '.' + $ownerToken + ".sha256.partial")

function Get-RelativeUnixPath {
  param([string]$BasePath, [string]$FullPath)
  $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
  $resolvedFullPath = [System.IO.Path]::GetFullPath($FullPath)
  $prefix = $baseFullPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedFullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the expected base directory: $FullPath"
  }
  return $resolvedFullPath.Substring($prefix.Length).Replace('\', '/')
}

function Resolve-BuildSourceRoot {
  param([string]$ProjectRoot, [string]$SelectedRoot)
  if ([string]::IsNullOrWhiteSpace($SelectedRoot)) { return $ProjectRoot }
  $container = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'output/release-source-inputs'))
  $selected = [System.IO.Path]::GetFullPath($SelectedRoot).TrimEnd('\', '/')
  if (-not [System.IO.Path]::IsPathRooted($SelectedRoot) -or
      $SelectedRoot.TrimEnd('\', '/').Replace('/', '\') -ine $selected -or
      [System.IO.Path]::GetDirectoryName($selected) -ine $container) {
    throw 'Independent build source must be a canonical direct child of output/release-source-inputs.'
  }
  $cursor = $selected
  while ($true) {
    $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw 'Independent build source ancestry must contain only ordinary directories.'
    }
    if ($cursor -ieq $ProjectRoot) { break }
    $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($cursor)) { throw 'Independent source escaped the workspace.' }
  }
  return $selected
}

function Get-TextSha256 {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-PathSortKey {
  param([string]$Path)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path)
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Assert-CanonicalRelativePath {
  param([string]$RelativePath)
  if (
    [string]::IsNullOrWhiteSpace($RelativePath) -or
    $RelativePath.Contains('\') -or
    $RelativePath.Contains(':') -or
    [System.IO.Path]::IsPathRooted($RelativePath)
  ) {
    throw "Non-canonical relative path: $RelativePath"
  }
  $segments = @($RelativePath.Split('/'))
  foreach ($segment in $segments) {
    if (
      [string]::IsNullOrEmpty($segment) -or
      $segment -eq '.' -or
      $segment -eq '..' -or
      $segment.EndsWith(' ') -or
      $segment.EndsWith('.')
    ) {
      throw "Non-canonical relative path: $RelativePath"
    }
  }
  $canonicalPath = $segments -join '/'
  if ($RelativePath -cne $canonicalPath) {
    throw "Non-canonical relative path: $RelativePath"
  }
  return $RelativePath
}

function Get-RequiredObjectPropertyValue {
  param(
    [object]$Object,
    [string]$Name
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or [string]$property.Name -cne $Name) {
    throw "Required manifest property is missing or duplicated: $Name"
  }
  return $property.Value
}

function Get-NonNegativeInt64ManifestValue {
  param(
    [object]$Value,
    [string]$Name
  )
  if ($null -eq $Value) {
    throw "Manifest integer property is invalid: $Name"
  }
  $typeCode = [System.Type]::GetTypeCode($Value.GetType()).ToString()
  if (@('Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64') -notcontains $typeCode) {
    throw "Manifest integer property is invalid: $Name"
  }
  $number = [int64]$Value
  if ($number -lt 0) {
    throw "Manifest integer property is invalid: $Name"
  }
  return $number
}

function Assert-SafePackagePath {
  param(
    [string]$RelativePath,
    [switch]$AllowSourceMapMetadata
  )
  [void](Assert-CanonicalRelativePath -RelativePath $RelativePath)
  $relativeLower = $RelativePath.Replace('\', '/').ToLowerInvariant()
  $normalized = '/' + $relativeLower + '/'
  $forbidden = @('/.runtime/', '/nantong-schedule-state/', '/logs/', '/node_modules/', '/certs/')
  foreach ($segment in $forbidden) {
    if ($normalized.Contains($segment)) {
      throw "Forbidden package path: $RelativePath"
    }
  }
  foreach ($pathSegment in @($relativeLower.Split('/'))) {
    if ($pathSegment.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Forbidden environment file: $RelativePath"
    }
  }
  $forbiddenExtensions = @(
    '.map',
    '.pem',
    '.key',
    '.pfx',
    '.p12',
    '.crt',
    '.cer',
    '.der',
    '.jks',
    '.keystore'
  )
  $extension = [System.IO.Path]::GetExtension($relativeLower)
  if (
    $forbiddenExtensions -contains $extension -and
    -not ($AllowSourceMapMetadata -and $extension -eq '.map')
  ) {
    throw "Forbidden source map, certificate, or private-key file: $RelativePath"
  }
}

function Assert-BaselineExportManifest {
  param([string]$ExportRoot)
  $manifestPath = Join-Path $ExportRoot 'server-baseline-manifest.json'
  $baselineDataRoot = Join-Path $ExportRoot 'baseline'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Required server baseline export manifest is missing: server-baseline-manifest.json'
  }
  if (-not (Test-Path -LiteralPath $baselineDataRoot -PathType Container)) {
    throw 'Required server baseline export directory is missing: baseline'
  }
  $baselineManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $schemaVersion = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'schemaVersion') `
    -Name 'schemaVersion'
  $exportType = [string](Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'exportType')
  $exportPlanAlgorithm = [string](Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'exportPlanAlgorithm')
  $baseFingerprint = [string](Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'baseFingerprint')
  $baselineFingerprint = [string](Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'baselineFingerprint')
  $exportPlanFingerprint = [string](Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'exportPlanFingerprint')
  $distFingerprints = Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'distFingerprints'
  $manifestFiles = @(Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'files')
  $metadataFiles = @(Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'nonExportedRuntimeFiles')
  $expectedFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'fileCount') `
    -Name 'fileCount'
  $expectedBaselineFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'baselineFileCount') `
    -Name 'baselineFileCount'
  $expectedMetadataFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'nonExportedRuntimeFileCount') `
    -Name 'nonExportedRuntimeFileCount'
  $expectedUncompressedBytes = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $baselineManifest -Name 'uncompressedBytes') `
    -Name 'uncompressedBytes'
  if (
    $schemaVersion -ne 3 -or
    $exportType -cne 'server-hotfix-baseline-read-only' -or
    $exportPlanAlgorithm -cne 'webpack-main-runtime-map-v1'
  ) {
    throw 'Unsupported server baseline export manifest.'
  }
  foreach ($fingerprint in @(
    $baseFingerprint,
    $baselineFingerprint,
    $exportPlanFingerprint
  )) {
    if ($fingerprint -cnotmatch '^[0-9a-f]{64}$') {
      throw 'Server baseline export manifest contains an invalid fingerprint.'
    }
  }
  foreach ($runtimeRoot in @('dist/server', 'dist/shared', 'dist/client')) {
    $fingerprintProperty = @(
      $distFingerprints.PSObject.Properties |
        Where-Object { $_.Name -ceq $runtimeRoot }
    )
    if (
      $fingerprintProperty.Count -ne 1 -or
      [string]$fingerprintProperty[0].Value -cnotmatch '^[0-9a-f]{64}$'
    ) {
      throw "Server baseline export manifest contains an invalid dist fingerprint: $runtimeRoot"
    }
  }

  $payloadFilesByRelativePath = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $baselineDataRoot -File -Force -Recurse)) {
    $relativePath = Get-RelativeUnixPath -BasePath $baselineDataRoot -FullPath $file.FullName
    if ($payloadFilesByRelativePath.ContainsKey($relativePath)) {
      throw "Duplicate file in server baseline export: $relativePath"
    }
    $payloadFilesByRelativePath[$relativePath] = $file
  }

  $payloadExpectedPaths = @{}
  $baselineExpectedPaths = @{}
  $verifiedSortKeyByPath = @{}
  $verifiedFiles = New-Object System.Collections.Generic.List[object]
  $uncompressedBytes = [int64]0
  foreach ($entry in $manifestFiles) {
    $relativePath = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'path')
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    Assert-SafePackagePath -RelativePath $relativePath
    if (
      [string]::IsNullOrWhiteSpace($relativePath) -or
      [System.IO.Path]::IsPathRooted($relativePath) -or
      @($relativePath.Split('/')) -contains '..'
    ) {
      throw "Invalid server baseline manifest path: $relativePath"
    }
    $manifestHash = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'sha256')
    $manifestSize = Get-NonNegativeInt64ManifestValue `
      -Value (Get-RequiredObjectPropertyValue -Object $entry -Name 'size') `
      -Name "files.size:$relativePath"
    if ($manifestHash -cnotmatch '^[0-9a-f]{64}$') {
      throw "Invalid server baseline manifest hash or size: $relativePath"
    }
    if ($baselineExpectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate server baseline manifest path: $relativePath"
    }
    $baselineExpectedPaths[$relativePath] = $true
    $payloadExpectedPaths[$relativePath] = $true
    $verifiedSortKeyByPath[$relativePath] = Get-PathSortKey -Path $relativePath
    if (-not $payloadFilesByRelativePath.ContainsKey($relativePath)) {
      throw "Server baseline manifest file is missing: $relativePath"
    }
    $payloadFile = $payloadFilesByRelativePath[$relativePath]
    $fullPath = [string]$payloadFile.FullName
    $actualSize = [int64]$payloadFile.Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne $manifestSize -or $actualHash -cne $manifestHash) {
      throw "Server baseline manifest file hash or size mismatch: $relativePath"
    }
    $uncompressedBytes += $actualSize
    [void]$verifiedFiles.Add([ordered]@{
      path = $relativePath
      size = $actualSize
      sha256 = $actualHash
    })
  }
  foreach ($entry in $metadataFiles) {
    $relativePath = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'path')
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    $reason = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'reason')
    Assert-SafePackagePath -RelativePath $relativePath -AllowSourceMapMetadata
    if (
      [string]::IsNullOrWhiteSpace($relativePath) -or
      [System.IO.Path]::IsPathRooted($relativePath) -or
      $relativePath.Contains(':') -or
      @($relativePath.Split('/')) -contains '..'
    ) {
      throw "Invalid metadata-only server baseline path: $relativePath"
    }
    $validReasonPath = switch ($reason) {
      'source-map-content-not-exported' {
        $relativePath -match '^dist/(server|shared|client)/.+\.map$'
        break
      }
      'unreferenced-client-chunk-content-not-exported' {
        $relativePath -match '^dist/client/chunks/[^/]+\.[0-9a-f]{8,64}(?:\.legacy)?\.(?:js|css)$'
        break
      }
      default { $false }
    }
    if (-not $validReasonPath) {
      throw "Unsupported metadata-only server baseline reason: $relativePath"
    }
    if ($baselineExpectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate server baseline manifest path: $relativePath"
    }
    $metadataHash = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'sha256')
    $metadataSize = Get-NonNegativeInt64ManifestValue `
      -Value (Get-RequiredObjectPropertyValue -Object $entry -Name 'size') `
      -Name "nonExportedRuntimeFiles.size:$relativePath"
    if ($metadataHash -cnotmatch '^[0-9a-f]{64}$') {
      throw "Invalid metadata-only server baseline hash or size: $relativePath"
    }
    if ($payloadFilesByRelativePath.ContainsKey($relativePath)) {
      throw "Metadata-only server baseline content must not be exported: $relativePath"
    }
    $baselineExpectedPaths[$relativePath] = $true
    $verifiedSortKeyByPath[$relativePath] = Get-PathSortKey -Path $relativePath
    [void]$verifiedFiles.Add([ordered]@{
      path = $relativePath
      size = $metadataSize
      sha256 = $metadataHash
      reason = $reason
    })
  }
  foreach ($relativePath in @($payloadFilesByRelativePath.Keys)) {
    if (-not $payloadExpectedPaths.ContainsKey($relativePath)) {
      throw "Unexpected file in server baseline export: $relativePath"
    }
  }
  if (
    $verifiedFiles.Count -ne $baselineExpectedPaths.Count -or
    $expectedFileCount -ne $manifestFiles.Count -or
    $expectedBaselineFileCount -ne $verifiedFiles.Count -or
    $expectedMetadataFileCount -ne $metadataFiles.Count -or
    $expectedUncompressedBytes -ne $uncompressedBytes
  ) {
    throw 'Server baseline export file set is incomplete.'
  }

  $fingerprintMaterial = @(
    $verifiedFiles |
      Sort-Object { [string]$verifiedSortKeyByPath[[string]$_.path] } |
      ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
  ) -join "`n"
  $actualBaselineFingerprint = Get-TextSha256 -Text $fingerprintMaterial
  if ($actualBaselineFingerprint -cne $baselineFingerprint) {
    throw 'Server baseline export baselineFingerprint mismatch.'
  }
  foreach ($runtimeRoot in @('dist/server', 'dist/shared', 'dist/client')) {
    $runtimePrefix = $runtimeRoot + '/'
    $runtimeMaterial = @(
      $verifiedFiles |
        Where-Object { $_.path.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase) } |
        Sort-Object { [string]$verifiedSortKeyByPath[[string]$_.path] } |
        ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
    ) -join "`n"
    $expectedProperty = @($distFingerprints.PSObject.Properties | Where-Object { $_.Name -ceq $runtimeRoot })
    if ($expectedProperty.Count -ne 1 -or (Get-TextSha256 -Text $runtimeMaterial) -cne [string]$expectedProperty[0].Value) {
      throw "Server baseline export distFingerprints mismatch: $runtimeRoot"
    }
  }
  $exportPlanMaterial = @(
    $verifiedFiles |
      Sort-Object { [string]$verifiedSortKeyByPath[[string]$_.path] } |
      ForEach-Object {
        $hasReason = $_ -is [System.Collections.IDictionary] -and $_.Contains('reason')
        if ($hasReason) {
          "metadata`0$([string]$_.reason)`0$($_.path)`0$($_.size)`0$($_.sha256)"
        } else {
          "payload`0$($_.path)`0$($_.size)`0$($_.sha256)"
        }
      }
  ) -join "`n"
  if ((Get-TextSha256 -Text $exportPlanMaterial) -cne $exportPlanFingerprint) {
    throw 'Server baseline export exportPlanFingerprint mismatch.'
  }
  return [pscustomobject]@{
    BaselineRoot = $baselineDataRoot
    Manifest = $baselineManifest
    VerifiedFiles = @($verifiedFiles | ForEach-Object { $_ })
  }
}

function Remove-ZoneIdentifierStreamsFromArchiveStage {
  param([string]$Root)

  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are forbidden in archive stage content: $($rootItem.FullName)"
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in archive stage content: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
      $zoneStream = @(
        Get-Item -LiteralPath $item.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
      )
      if ($zoneStream.Count -gt 0) {
        Remove-Item -LiteralPath $item.FullName -Stream 'Zone.Identifier' -Force -ErrorAction Stop
      }
    }
  }
}

function Assert-ArchiveStageHasNoReparsePointsOrAlternateDataStreams {
  param([string]$Root)

  $items = @((Get-Item -LiteralPath $Root -Force -ErrorAction Stop)) + @(
    Get-ChildItem -LiteralPath $Root -Force -Recurse
  )
  foreach ($item in $items) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in archive stage content: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
      foreach ($stream in @(Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction SilentlyContinue)) {
        if (@(':$DATA', '$DATA') -notcontains [string]$stream.Stream) {
          throw "Alternate data streams are forbidden in archive stage content: $($item.FullName)"
        }
      }
    }
  }
}

function Assert-SnapshotSourceItem {
  param([string]$Path)

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are forbidden in clean-build sources: $($item.Name)"
  }
  if (-not $item.PSIsContainer) {
    foreach ($stream in @(Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction SilentlyContinue)) {
      if (@(':$DATA', '$DATA') -notcontains [string]$stream.Stream) {
        throw "Alternate data streams are forbidden in clean-build sources: $($item.Name)"
      }
    }
  }
}

function Get-SourceSnapshotFingerprint {
  param(
    [string]$Root,
    [string[]]$DirectoryAllowlist,
    [string[]]$FileAllowlist
  )

  $entries = @{}
  foreach ($relativeDirectory in $DirectoryAllowlist) {
    $directoryPath = Join-Path $Root $relativeDirectory
    if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
      throw "Required clean-build source directory is missing: $relativeDirectory"
    }
    Assert-SnapshotSourceItem -Path $directoryPath
    foreach ($item in @(Get-ChildItem -LiteralPath $directoryPath -Force -Recurse)) {
      Assert-SnapshotSourceItem -Path $item.FullName
      if ($item.PSIsContainer) {
        continue
      }
      $relativePath = Get-RelativeUnixPath -BasePath $Root -FullPath $item.FullName
      if ($entries.ContainsKey($relativePath)) {
        throw "Duplicate clean-build source path: $relativePath"
      }
      $entries[$relativePath] = [ordered]@{
        path = $relativePath
        size = [int64]$item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  }
  foreach ($relativeFile in $FileAllowlist) {
    $filePath = Join-Path $Root $relativeFile
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "Required clean-build source file is missing: $relativeFile"
    }
    Assert-SnapshotSourceItem -Path $filePath
    $relativePath = Get-RelativeUnixPath -BasePath $Root -FullPath $filePath
    if ($entries.ContainsKey($relativePath)) {
      throw "Duplicate clean-build source path: $relativePath"
    }
    $file = Get-Item -LiteralPath $filePath -Force
    $entries[$relativePath] = [ordered]@{
      path = $relativePath
      size = [int64]$file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }

  $material = @(
    $entries.Values |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object { "$($_.path)`0$($_.size)`0$($_.sha256)" }
  ) -join "`n"
  return Get-TextSha256 -Text $material
}

function New-CleanBuildSnapshot {
  param(
    [string]$SourceRoot,
    [string]$DestinationRoot,
    [string[]]$DirectoryAllowlist,
    [string[]]$FileAllowlist
  )

  if (Test-Path -LiteralPath $DestinationRoot) {
    throw "Clean-build snapshot path already exists: $DestinationRoot"
  }
  New-Item -ItemType Directory -Path $DestinationRoot | Out-Null
  foreach ($relativeDirectory in $DirectoryAllowlist) {
    $source = Join-Path $SourceRoot $relativeDirectory
    $destination = Join-Path $DestinationRoot $relativeDirectory
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
  }
  foreach ($relativeFile in $FileAllowlist) {
    $source = Join-Path $SourceRoot $relativeFile
    $destination = Join-Path $DestinationRoot $relativeFile
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
}

function Resolve-VerifiedProductionNodeModulesRoot {
  param(
    [string]$Path,
    [string]$ExpectedProjectRoot
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Verified production node_modules root is required for a formal hotfix build.'
  }
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $expected = [System.IO.Path]::GetFullPath((Join-Path $ExpectedProjectRoot 'node_modules'))
  if (-not $resolved.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Verified production node_modules root must be the current project node_modules directory.'
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw 'Verified production node_modules root is not a directory.'
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $resolved
  $rootItem = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Verified production node_modules root must not be a reparse point.'
  }
  return $resolved
}

function Assert-ReusedProductionFeishuSdkPatch {
  param([string]$NodeModulesRoot)

  $sdkRoot = Join-Path $NodeModulesRoot '@larksuiteoapi\node-sdk'
  $packagePath = Join-Path $sdkRoot 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw 'Verified production dependency tree is missing @larksuiteoapi/node-sdk.'
  }
  $sdkPackage = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  if ([string]$sdkPackage.version -cne '1.73.0') {
    throw 'Verified production dependency tree contains an unsupported Feishu SDK version.'
  }
  $patchedGuard = 'if (type !== MessageType.event && type !== MessageType.card)'
  $unpatchedGuard = 'if (type !== MessageType.event)'
  foreach ($bundle in @('lib\index.js', 'es\index.js')) {
    $bundlePath = Join-Path $sdkRoot $bundle
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
      throw "Verified production dependency tree is missing Feishu SDK bundle: $bundle"
    }
    $source = [System.IO.File]::ReadAllText($bundlePath)
    if (-not $source.Contains($patchedGuard) -or $source.Contains($unpatchedGuard)) {
      throw "Verified production dependency tree has an unpatched Feishu SDK bundle: $bundle"
    }
  }
}

function Assert-ReusedBuildToolchain {
  param(
    [object]$BuildTools,
    [string]$NpmConfigPath,
    [string]$ScriptPath,
    [string]$WorkingDirectory,
    [string]$NodeModulesRoot,
    [string]$PackagePath,
    [string]$LockPath
  )

  $report = Invoke-NodeJsonGate `
    -BuildTools $BuildTools `
    -NpmConfigPath $NpmConfigPath `
    -ScriptPath $ScriptPath `
    -WorkingDirectory $WorkingDirectory `
    -Arguments @(
      '--package', $PackagePath,
      '--lock', $LockPath,
      '--node-modules-root', $NodeModulesRoot
    ) `
    -Label 'Reusable build toolchain gate'
  if (
    -not [bool]$report.success -or
    [string]$report.fingerprint -cnotmatch '^[0-9a-f]{64}$' -or
    @($report.packages).Count -ne 5
  ) {
    throw 'Reusable build toolchain gate did not prove the locked build dependencies.'
  }
  return $report
}

function Remove-ProjectBuildSnapshot {
  param(
    [string]$Path,
    [string]$ProjectRoot
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $allowedParent = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'output')).TrimEnd('\', '/')
  $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $fullPath)).TrimEnd('\', '/')
  $leaf = Split-Path -Leaf $fullPath
  if (
    -not [string]::Equals($parent, $allowedParent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $leaf -cnotmatch '^\.nantong-hotfix-build-source-\d{8}-\d{6}-[0-9a-f]{32}$'
  ) {
    throw "Refusing to remove an unexpected project build snapshot: $fullPath"
  }
  if (-not (Test-Path -LiteralPath $fullPath)) {
    return
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
    throw "Project build snapshot is not a directory: $fullPath"
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath
  foreach ($item in @(Get-ChildItem -LiteralPath $fullPath -Force -Recurse)) {
    Assert-SnapshotSourceItem -Path $item.FullName
  }
  Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $fullPath) {
    throw "Project build snapshot still exists after cleanup: $fullPath"
  }
}

function Get-DirectoryStateFingerprint {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 'absent'
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Expected directory is not a directory: $Path"
  }
  Assert-SnapshotSourceItem -Path $Path
  $entries = @(
    Get-ChildItem -LiteralPath $Path -File -Force -Recurse |
      ForEach-Object {
        Assert-SnapshotSourceItem -Path $_.FullName
        $relativePath = Get-RelativeUnixPath -BasePath $Path -FullPath $_.FullName
        [ordered]@{
          path = $relativePath
          size = [int64]$_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      }
  )
  $material = @(
    $entries |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object { "$($_.path)`0$($_.size)`0$($_.sha256)" }
  ) -join "`n"
  return Get-TextSha256 -Text $material
}

function Invoke-WithSanitizedBuildEnvironment {
  param(
    [string]$NodeRoot,
    [string]$WorkingDirectory,
    [string]$NpmConfigPath,
    [scriptblock]$Action
  )

  $originalEnvironment = @{}
  foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    $originalEnvironment[[string]$entry.Key] = [string]$entry.Value
  }
  $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Process')
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    $systemRoot = [Environment]::GetEnvironmentVariable('WINDIR', 'Process')
  }
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    throw 'SystemRoot is required for the sanitized build environment.'
  }
  $npmUserConfigPath = [System.IO.Path]::GetFullPath($NpmConfigPath)
  $npmGlobalConfigPath = [System.IO.Path]::GetFullPath("$NpmConfigPath.global")
  $npmConfigHandles = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($configDescriptor in @(
      [pscustomobject]@{ Path = $npmUserConfigPath; Label = 'Sanitized npm user config' },
      [pscustomobject]@{ Path = $npmGlobalConfigPath; Label = 'Sanitized npm global config' }
    )) {
      $configControl = Open-VerifiedControlledFile `
        -Path ([string]$configDescriptor.Path) `
        -Share ([System.IO.FileShare]::Read) `
        -RequireSingleLink `
        -Label ([string]$configDescriptor.Label)
      [void]$npmConfigHandles.Add($configControl)
      $configControl.Stream.Position = 0
      $reader = [System.IO.StreamReader]::new(
        $configControl.Stream,
        [System.Text.Encoding]::UTF8,
        $true,
        1024,
        $true
      )
      try {
        if (-not [string]::IsNullOrWhiteSpace($reader.ReadToEnd())) {
          throw "$([string]$configDescriptor.Label) must be empty."
        }
      } finally {
        $reader.Dispose()
      }
    }
  $safeInheritedNames = @(
    'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
    'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'
  )
  $safeEnvironment = [ordered]@{}
  foreach ($name in $safeInheritedNames) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $safeEnvironment[$name] = $value
    }
  }
  $safeEnvironment['Path'] = @(
    [System.IO.Path]::GetFullPath($NodeRoot),
    (Join-Path $systemRoot 'System32'),
    (Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0')
  ) -join ';'
  $safeEnvironment['NODE_ENV'] = 'production'
  $safeEnvironment['CLIENT_BASE_PATH'] = '/'
  $safeEnvironment['CI'] = 'true'
  $safeEnvironment['NPM_CONFIG_USERCONFIG'] = $npmUserConfigPath
  $safeEnvironment['NPM_CONFIG_GLOBALCONFIG'] = $npmGlobalConfigPath
  $safeEnvironment['NPM_CONFIG_UPDATE_NOTIFIER'] = 'false'
  $safeEnvironment['NPM_CONFIG_AUDIT'] = 'false'
  $safeEnvironment['NPM_CONFIG_FUND'] = 'false'
  $blockedEnvironmentNames = @('NODE_OPTIONS', 'NODE_PATH')

  try {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($entry in $safeEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
    foreach ($blockedName in $blockedEnvironmentNames) {
      if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($blockedName, 'Process'))) {
        throw "Forbidden inherited build variable survived environment sanitization: $blockedName"
      }
    }
    # Inherited npm config, proxy and credential variables are absent by construction.
    Push-Location -LiteralPath $WorkingDirectory
    try {
      return & $Action
    } finally {
      Pop-Location
    }
  } finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($entry in $originalEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
  }
  } finally {
    foreach ($npmConfigHandle in $npmConfigHandles) {
      $npmConfigHandle.Stream.Dispose()
    }
  }
}

function Resolve-VerifiedBuildTools {
  param(
    [string]$NodePath,
    [string]$NpmPath
  )

  if ([string]::IsNullOrWhiteSpace($NodePath) -or [string]::IsNullOrWhiteSpace($NpmPath)) {
    throw 'Explicit BuildNodePath and BuildNpmPath are required for a formal hotfix build.'
  }
  $resolvedNode = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
  $resolvedNpm = (Resolve-Path -LiteralPath $NpmPath -ErrorAction Stop).Path
  if ([System.IO.Path]::GetFileName($resolvedNode) -cne 'node.exe') {
    throw 'BuildNodePath must identify the exact node.exe entry.'
  }
  $nodeRoot = Split-Path -Parent $resolvedNode
  $expectedNpmPath = [System.IO.Path]::GetFullPath(
    (Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js')
  )
  if (-not $resolvedNpm.Equals($expectedNpmPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build Node and npm must belong to the same portable distribution at node_modules\npm\bin\npm-cli.js.'
  }

  $nodeControl = Open-VerifiedControlledFile `
    -Path $resolvedNode `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Build node.exe'
  $npmControl = Open-VerifiedControlledFile `
    -Path $resolvedNpm `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Build npm-cli.js'
  try {
    $nodeSignature = Get-AuthenticodeSignature -LiteralPath $resolvedNode
    if (
      [string]$nodeSignature.Status -cne 'Valid' -or
      -not $nodeSignature.SignerCertificate -or
      -not ([string]$nodeSignature.SignerCertificate.Subject).Contains('OpenJS Foundation')
    ) {
      throw 'Build node.exe must carry a valid OpenJS Foundation signature.'
    }
    $npmPackageJsonPath = Join-Path $nodeRoot 'node_modules\npm\package.json'
    $npmPackageControl = Open-VerifiedControlledFile `
      -Path $npmPackageJsonPath `
      -Share ([System.IO.FileShare]::Read) `
      -RequireSingleLink `
      -Label 'Build npm package manifest'
    try {
      $npmPackage = Get-Content -LiteralPath $npmPackageJsonPath -Raw | ConvertFrom-Json
      if ([string]$npmPackage.name -cne 'npm' -or [string]$npmPackage.version -cne '11.12.1') {
        throw 'Build npm package manifest must identify npm 11.12.1.'
      }
      $versionNpmrc = Join-Path ([System.IO.Path]::GetTempPath()) ("nantong-hotfix-version-" + [Guid]::NewGuid().ToString('N') + '.npmrc')
      Set-Content -LiteralPath $versionNpmrc -Value '' -Encoding ascii
      Set-Content -LiteralPath "$versionNpmrc.global" -Value '' -Encoding ascii
      try {
        $versionProof = Invoke-WithSanitizedBuildEnvironment `
          -NodeRoot $nodeRoot `
          -WorkingDirectory $nodeRoot `
          -NpmConfigPath $versionNpmrc `
          -Action {
            $nodeVersionOutput = ((& $resolvedNode -p 'process.versions.node') | Out-String).Trim()
            $nodeExitCode = $LASTEXITCODE
            $npmVersionOutput = ((& $resolvedNode $resolvedNpm '--version') | Out-String).Trim()
            $npmExitCode = $LASTEXITCODE
            [pscustomobject]@{
              NodeVersion = $nodeVersionOutput
              NodeExitCode = $nodeExitCode
              NpmVersion = $npmVersionOutput
              NpmExitCode = $npmExitCode
            }
          }
      } finally {
        Remove-Item -LiteralPath $versionNpmrc, "$versionNpmrc.global" -Force -ErrorAction SilentlyContinue
      }
      $nodeVersion = [string]$versionProof.NodeVersion
      $npmVersion = [string]$versionProof.NpmVersion
      if ([int]$versionProof.NodeExitCode -ne 0 -or $nodeVersion -cne '24.15.0') {
        throw "Build Node version must be exactly 24.15.0; received: $nodeVersion"
      }
      if ([int]$versionProof.NpmExitCode -ne 0 -or $npmVersion -cne '11.12.1') {
        throw "Build npm version must be exactly 11.12.1; received: $npmVersion"
      }
      return [pscustomobject]@{
        NodePath = $resolvedNode
        NpmPath = $resolvedNpm
        NpmPackageJsonPath = $npmPackageJsonPath
        NodeRoot = $nodeRoot
        NodeVersion = $nodeVersion
        NpmVersion = $npmVersion
        NodeSha256 = $nodeControl.Sha256
        NpmSha256 = $npmControl.Sha256
        NpmPackageSha256 = $npmPackageControl.Sha256
        NodeIdentity = $nodeControl.Identity
        NpmIdentity = $npmControl.Identity
        NpmPackageIdentity = $npmPackageControl.Identity
      }
    } finally {
      $npmPackageControl.Stream.Dispose()
    }
  } finally {
    $nodeControl.Stream.Dispose()
    $npmControl.Stream.Dispose()
  }
}

function Open-VerifiedBuildToolHandles {
  param([object]$BuildTools)

  $descriptors = @(
    [pscustomobject]@{ Path = $BuildTools.NodePath; Sha256 = $BuildTools.NodeSha256; Identity = $BuildTools.NodeIdentity; Label = 'Build node.exe' },
    [pscustomobject]@{ Path = $BuildTools.NpmPath; Sha256 = $BuildTools.NpmSha256; Identity = $BuildTools.NpmIdentity; Label = 'Build npm-cli.js' },
    [pscustomobject]@{ Path = $BuildTools.NpmPackageJsonPath; Sha256 = $BuildTools.NpmPackageSha256; Identity = $BuildTools.NpmPackageIdentity; Label = 'Build npm package manifest' }
  )
  $handles = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($descriptor in $descriptors) {
      $controlled = Open-VerifiedControlledFile `
        -Path ([string]$descriptor.Path) `
        -Share ([System.IO.FileShare]::Read) `
        -RequireSingleLink `
        -Label ([string]$descriptor.Label)
      if (
        [string]$controlled.Sha256 -cne [string]$descriptor.Sha256 -or
        -not (Test-ControlledFileIdentityEqual -Left $controlled.Identity -Right $descriptor.Identity)
      ) {
        $controlled.Stream.Dispose()
        throw "Build tool changed after verification: $([string]$descriptor.Label)"
      }
      [void]$handles.Add($controlled)
    }
    return @($handles | ForEach-Object { $_ })
  } catch {
    foreach ($handle in $handles) {
      $handle.Stream.Dispose()
    }
    throw
  }
}

function Close-BuildToolHandles {
  param([object[]]$Handles)

  foreach ($handle in @($Handles)) {
    if ($handle -and $handle.Stream) {
      $handle.Stream.Dispose()
    }
  }
}

function Assert-BuildToolsUnchanged {
  param([object]$BuildTools)

  $handles = Open-VerifiedBuildToolHandles -BuildTools $BuildTools
  Close-BuildToolHandles -Handles $handles
}

function Invoke-CheckedNodeCommand {
  param(
    [object]$BuildTools,
    [string]$WorkingDirectory,
    [string[]]$Arguments,
    [string]$Label,
    [string]$NpmConfigPath
  )

  $resultId = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $WorkingDirectory ".hotfix-command-$resultId.stdout"
  $stderrPath = Join-Path $WorkingDirectory ".hotfix-command-$resultId.stderr"
  $toolHandles = Open-VerifiedBuildToolHandles -BuildTools $BuildTools
  $commandScriptControl = $null
  try {
    if (
      $Arguments.Count -gt 0 -and
      ([string]$Arguments[0]).EndsWith('.mjs', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      $commandScriptControl = Open-VerifiedControlledFile `
        -Path ([string]$Arguments[0]) `
        -Share ([System.IO.FileShare]::Read) `
        -RequireSingleLink `
        -Label 'Build command script'
    }
    $exitCode = Invoke-WithSanitizedBuildEnvironment `
      -NodeRoot $BuildTools.NodeRoot `
      -WorkingDirectory $WorkingDirectory `
      -NpmConfigPath $NpmConfigPath `
      -Action {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          & $BuildTools.NodePath @Arguments 1> $stdoutPath 2> $stderrPath
          $nativeExitCode = [int]$LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousErrorActionPreference
        }
        $nativeExitCode
      }
  } finally {
    if ($commandScriptControl) {
      $commandScriptControl.Stream.Dispose()
    }
    Close-BuildToolHandles -Handles $toolHandles
  }
  foreach ($line in @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue)) {
    Write-Host $line
  }
  if ($exitCode -ne 0) {
    foreach ($line in @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue)) {
      Write-Host $line
    }
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    throw "$Label failed with exit code $exitCode."
  }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}

function Invoke-NodeJsonGate {
  param(
    [object]$BuildTools,
    [string]$ScriptPath,
    [string]$WorkingDirectory,
    [string[]]$Arguments,
    [string]$Label,
    [string]$NpmConfigPath,
    [string]$JsonReportPath
  )

  $resultId = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $WorkingDirectory ".hotfix-gate-$resultId.stdout"
  $stderrPath = Join-Path $WorkingDirectory ".hotfix-gate-$resultId.stderr"
  if ($JsonReportPath -and (Test-Path -LiteralPath $JsonReportPath)) {
    throw "JSON gate report path already exists: $JsonReportPath"
  }
  $gateScriptControl = Open-VerifiedControlledFile `
    -Path $ScriptPath `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Build verification gate script'
  $toolHandles = $null
  try {
    try {
      $toolHandles = Open-VerifiedBuildToolHandles -BuildTools $BuildTools
      $exitCode = Invoke-WithSanitizedBuildEnvironment `
        -NodeRoot $BuildTools.NodeRoot `
        -WorkingDirectory $WorkingDirectory `
        -NpmConfigPath $NpmConfigPath `
        -Action {
          $previousErrorActionPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            & $BuildTools.NodePath $ScriptPath @Arguments 1> $stdoutPath 2> $stderrPath
            $nativeExitCode = [int]$LASTEXITCODE
          } finally {
            $ErrorActionPreference = $previousErrorActionPreference
          }
          $nativeExitCode
        }
    } finally {
      Close-BuildToolHandles -Handles $toolHandles
    }
    $nativeStdoutText = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
    if ($JsonReportPath -and -not [string]::IsNullOrWhiteSpace([string]$nativeStdoutText)) {
      throw "$Label wrote unexpected native stdout instead of its controlled JSON report."
    }
    $stdoutText = if ($JsonReportPath) {
      Get-Content -LiteralPath $JsonReportPath -Raw -ErrorAction SilentlyContinue
    } else {
      $nativeStdoutText
    }
    if ([string]::IsNullOrWhiteSpace([string]$stdoutText)) {
      throw "Expected exactly one JSON result from $Label."
    }
    try {
      $report = [string]$stdoutText | ConvertFrom-Json
    } catch {
      throw "Expected exactly one JSON result from $Label."
    }
    if ($exitCode -ne 0) {
      $gateError = if ($null -ne $report.error) { [string]$report.error } else { "exit code $exitCode" }
      throw "$Label failed: $gateError"
    }
    return $report
  } finally {
    $gateScriptControl.Stream.Dispose()
    $gateArtifacts = @($stdoutPath, $stderrPath)
    if ($JsonReportPath) {
      $gateArtifacts += $JsonReportPath
    }
    Remove-Item -LiteralPath $gateArtifacts -Force -ErrorAction SilentlyContinue
  }
}

function Assert-NoSourceMapsInRuntimeRoots {
  param([string]$SnapshotRoot)

  foreach ($runtimeRoot in @('dist\server', 'dist\shared', 'dist\client')) {
    $fullRoot = Join-Path $SnapshotRoot $runtimeRoot
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
      throw "Required clean-build runtime root is missing: $runtimeRoot"
    }
    if (@(Get-ChildItem -LiteralPath $fullRoot -File -Force -Recurse | Where-Object { $_.Extension -ieq '.map' }).Count -gt 0) {
      throw 'Source maps are forbidden in hotfix runtime roots.'
    }
  }
}

function Get-RuntimeBuildFingerprint {
  param([string]$SnapshotRoot)

  $descriptors = @(
    foreach ($runtimeRoot in @('dist/server', 'dist/shared')) {
      $fullRoot = Join-Path $SnapshotRoot $runtimeRoot
      foreach ($file in @(Get-ChildItem -LiteralPath $fullRoot -File -Force -Recurse)) {
        $relativePath = Get-RelativeUnixPath -BasePath $fullRoot -FullPath $file.FullName
        $sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$runtimeRoot`0$relativePath`0$($file.Length)`0$sha256"
      }
    }
  )
  $material = @($descriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }) -join "`n"
  return Get-TextSha256 -Text $material
}

function Get-ActiveClientAssetProof {
  param(
    [string]$ClientRoot,
    [object]$ClientReport,
    [int]$MaxActiveChunkCount
  )

  if (-not [bool]$ClientReport.ok -or @($ClientReport.missingAssets).Count -ne 0) {
    throw 'Active client asset graph verification failed.'
  }
  $assets = @($ClientReport.expectedAssets)
  $activeChunks = @($ClientReport.activeChunkAssets)
  if ($activeChunks.Count -eq 0 -or $activeChunks.Count -gt $MaxActiveChunkCount) {
    throw "Active client chunk count is outside the allowed range: $($activeChunks.Count)"
  }
  $clientRootFull = [System.IO.Path]::GetFullPath($ClientRoot).TrimEnd('\') + '\'
  $paths = @{}
  $entries = @(
    foreach ($assetValue in $assets) {
      $assetPath = ([string]$assetValue).Replace('\', '/')
      [void](Assert-CanonicalRelativePath -RelativePath $assetPath)
      if ($paths.ContainsKey($assetPath)) {
        throw "Duplicate active client asset: $assetPath"
      }
      $paths[$assetPath] = $true
      $fullPath = [System.IO.Path]::GetFullPath((Join-Path $ClientRoot $assetPath))
      if (-not $fullPath.StartsWith($clientRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Active client asset escapes the build root: $assetPath"
      }
      if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Active client asset is missing: $assetPath"
      }
      $file = Get-Item -LiteralPath $fullPath -Force
      $sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
      [pscustomobject][ordered]@{
        path = "dist/client/$assetPath"
        size = [int64]$file.Length
        sha256 = $sha256
      }
    }
  )
  $entries = @($entries | Sort-Object { Get-PathSortKey -Path ([string]$_.path) })
  $descriptors = @(
    foreach ($entry in $entries) {
      $assetPath = ([string]$entry.path).Substring('dist/client/'.Length)
      "asset`0$assetPath`0$([int64]$entry.size)`0$([string]$entry.sha256)"
    }
  )
  $material = @($descriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }) -join "`n"
  return [pscustomobject]@{
    Fingerprint = Get-TextSha256 -Text $material
    ActiveChunkCount = $activeChunks.Count
    AssetCount = $assets.Count
    Entries = $entries
  }
}

function Get-ArchiveExpectedEntries {
  param([string]$Root)

  return @(
    Get-ChildItem -LiteralPath $Root -File -Force -Recurse |
      ForEach-Object {
        $relativePath = Get-RelativeUnixPath -BasePath $Root -FullPath $_.FullName
        [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
        [ordered]@{
          path = $relativePath
          size = [int64]$_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      }
  )
}

function Get-ExactArchiveEntry {
  param(
    [object[]]$Entries,
    [string]$Path
  )

  $matches = @($Entries | Where-Object { [string]$_.path -ceq $Path })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one archive evidence entry: $Path"
  }
  return $matches[0]
}

function Get-RuntimeBuildFingerprintFromArchiveEntries {
  param([object[]]$Entries)

  $descriptors = @(
    foreach ($runtimeRoot in @('dist/server', 'dist/shared')) {
      $prefix = $runtimeRoot + '/'
      foreach ($entry in @($Entries | Where-Object {
        ([string]$_.path).StartsWith($prefix, [System.StringComparison]::Ordinal)
      })) {
        $relativePath = ([string]$entry.path).Substring($prefix.Length)
        "$runtimeRoot`0$relativePath`0$([int64]$entry.size)`0$([string]$entry.sha256)"
      }
    }
  )
  if ($descriptors.Count -eq 0) {
    throw 'Archive evidence is missing the server/shared runtime build.'
  }
  $material = @($descriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }) -join "`n"
  return Get-TextSha256 -Text $material
}

function Get-ActiveClientAssetProofFromArchiveEntries {
  param(
    [object[]]$Entries,
    [object]$ClientReport,
    [int]$MaxActiveChunkCount
  )

  if (-not [bool]$ClientReport.ok -or @($ClientReport.missingAssets).Count -ne 0) {
    throw 'Active client asset graph verification failed.'
  }
  $assets = @($ClientReport.expectedAssets)
  $activeChunks = @($ClientReport.activeChunkAssets)
  if ($activeChunks.Count -eq 0 -or $activeChunks.Count -gt $MaxActiveChunkCount) {
    throw "Active client chunk count is outside the allowed range: $($activeChunks.Count)"
  }
  $activeEntries = @(
    foreach ($assetValue in $assets) {
      $assetPath = ([string]$assetValue).Replace('\', '/')
      [void](Assert-CanonicalRelativePath -RelativePath $assetPath)
      $entry = Get-ExactArchiveEntry -Entries $Entries -Path ("dist/client/" + $assetPath)
      [pscustomobject][ordered]@{
        path = "dist/client/$assetPath"
        size = [int64]$entry.size
        sha256 = [string]$entry.sha256
      }
    }
  )
  $activeEntries = @($activeEntries | Sort-Object { Get-PathSortKey -Path ([string]$_.path) })
  $descriptors = @(
    foreach ($entry in $activeEntries) {
      $assetPath = ([string]$entry.path).Substring('dist/client/'.Length)
      "asset`0$assetPath`0$([int64]$entry.size)`0$([string]$entry.sha256)"
    }
  )
  $material = @($descriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }) -join "`n"
  return [pscustomobject]@{
    Fingerprint = Get-TextSha256 -Text $material
    ActiveChunkCount = $activeChunks.Count
    AssetCount = $assets.Count
    Entries = $activeEntries
  }
}

function Assert-ArchiveEvidenceBinding {
  param(
    [object[]]$Entries,
    [string]$ExpectedBuildFingerprint,
    [object]$ClientReport,
    [string]$ExpectedClientFingerprint,
    [string]$ExpectedPackageSha256,
    [string]$ExpectedPackageLockSha256,
    [int]$MaxActiveChunkCount
  )

  $archiveBuildFingerprint = Get-RuntimeBuildFingerprintFromArchiveEntries -Entries $Entries
  if ($archiveBuildFingerprint -cne $ExpectedBuildFingerprint) {
    throw 'Archive evidence no longer matches the gated runtime build.'
  }
  $archiveClientProof = Get-ActiveClientAssetProofFromArchiveEntries `
    -Entries $Entries `
    -ClientReport $ClientReport `
    -MaxActiveChunkCount $MaxActiveChunkCount
  if ([string]$archiveClientProof.Fingerprint -cne $ExpectedClientFingerprint) {
    throw 'Archive evidence no longer matches the gated active client asset graph.'
  }
  $packageEntry = Get-ExactArchiveEntry -Entries $Entries -Path 'release-root/package.json'
  $lockEntry = Get-ExactArchiveEntry -Entries $Entries -Path 'release-root/package-lock.json'
  if ([string]$packageEntry.sha256 -cne $ExpectedPackageSha256) {
    throw 'Archive evidence no longer matches the gated candidate package manifest.'
  }
  if ([string]$lockEntry.sha256 -cne $ExpectedPackageLockSha256) {
    throw 'Archive evidence no longer matches the gated candidate package lock.'
  }
}

function Assert-ReopenedHotfixArchive {
  param(
    [string]$ArchivePath,
    [object[]]$ExpectedEntries,
    [int64]$MaxArchiveBytes,
    [int64]$MaxUncompressedBytes
  )

  $archiveFile = Get-Item -LiteralPath $ArchivePath -Force -ErrorAction Stop
  if ($archiveFile.Length -gt $MaxArchiveBytes) {
    throw "Archive exceeds the compressed size limit: $($archiveFile.Length)"
  }
  $expectedByPath = @{}
  foreach ($expectedEntry in $ExpectedEntries) {
    $relativePath = [string]$expectedEntry.path
    if ($expectedByPath.ContainsKey($relativePath)) {
      throw "Duplicate expected archive entry: $relativePath"
    }
    $expectedByPath[$relativePath] = $expectedEntry
  }

  $archiveStream = [System.IO.FileStream]::new(
    $ArchivePath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try {
    $archive = [System.IO.Compression.ZipArchive]::new(
      $archiveStream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      $actualPaths = @{}
      $uncompressedBytes = [int64]0
      foreach ($entry in @($archive.Entries)) {
        $relativePath = ([string]$entry.FullName).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace([string]$entry.Name)) {
          throw "Unexpected archive entry: $relativePath"
        }
        [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
        if ($actualPaths.ContainsKey($relativePath) -or -not $expectedByPath.ContainsKey($relativePath)) {
          throw "Unexpected archive entry: $relativePath"
        }
        $expected = $expectedByPath[$relativePath]
        if ([string]$expected.path -cne $relativePath -or [int64]$entry.Length -ne [int64]$expected.size) {
          throw "Archive entry hash differs: $relativePath"
        }
        $uncompressedBytes += [int64]$entry.Length
        if ($uncompressedBytes -gt $MaxUncompressedBytes) {
          throw 'Archive uncompressed content exceeds the size limit.'
        }
        $entryStream = $entry.Open()
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
          $hash = $algorithm.ComputeHash($entryStream)
        } finally {
          $algorithm.Dispose()
          $entryStream.Dispose()
        }
        $actualHash = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
        if ($actualHash -cne [string]$expected.sha256) {
          throw "Archive entry hash differs: $relativePath"
        }
        $actualPaths[$relativePath] = $true
      }
      foreach ($relativePath in @($expectedByPath.Keys)) {
        if (-not $actualPaths.ContainsKey($relativePath)) {
          throw "Archive entry is missing: $relativePath"
        }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $archiveStream.Dispose()
  }
}

if (-not ('NantongHotfixPackagerNativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

[StructLayout(LayoutKind.Sequential)]
public struct NantongHotfixFileInformation {
  public uint FileAttributes;
  public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
  public uint VolumeSerialNumber;
  public uint FileSizeHigh;
  public uint FileSizeLow;
  public uint NumberOfLinks;
  public uint FileIndexHigh;
  public uint FileIndexLow;
}

public static class NantongHotfixPackagerNativeMethods {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandle(
    SafeFileHandle fileHandle,
    out NantongHotfixFileInformation fileInformation
  );
}
'@
}

function Get-ControlledFileIdentityFromStream {
  param([System.IO.FileStream]$Stream)

  $information = New-Object NantongHotfixFileInformation
  if (-not [NantongHotfixPackagerNativeMethods]::GetFileInformationByHandle(
    $Stream.SafeFileHandle,
    [ref]$information
  )) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Cannot read controlled file identity; Win32 error $errorCode."
  }
  return [pscustomobject]@{
    VolumeSerialNumber = [uint32]$information.VolumeSerialNumber
    FileIndexHigh = [uint32]$information.FileIndexHigh
    FileIndexLow = [uint32]$information.FileIndexLow
    NumberOfLinks = [uint32]$information.NumberOfLinks
  }
}

function Test-ControlledFileIdentityEqual {
  param(
    [object]$Left,
    [object]$Right
  )

  return (
    [uint32]$Left.VolumeSerialNumber -eq [uint32]$Right.VolumeSerialNumber -and
    [uint32]$Left.FileIndexHigh -eq [uint32]$Right.FileIndexHigh -and
    [uint32]$Left.FileIndexLow -eq [uint32]$Right.FileIndexLow
  )
}

function Get-ControlledStreamSha256 {
  param([System.IO.FileStream]$Stream)

  $originalPosition = $Stream.Position
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Stream.Position = 0
    $hash = $algorithm.ComputeHash($Stream)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $Stream.Position = $originalPosition
    $algorithm.Dispose()
  }
}

function Assert-PathHasNoReparsePointAncestorsForPackager {
  param([string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $current = $fullPath
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in trusted packager paths: $($item.FullName)"
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $current) {
      break
    }
    $current = $parent
  }
}

function Open-VerifiedControlledFile {
  param(
    [string]$Path,
    [System.IO.FileShare]$Share = [System.IO.FileShare]::Read,
    [switch]$RequireSingleLink,
    [string]$Label = 'Controlled file'
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath
  foreach ($stream in @(Get-Item -LiteralPath $fullPath -Stream * -ErrorAction Stop)) {
    if (@(':$DATA', '$DATA') -notcontains [string]$stream.Stream) {
      throw "$Label contains a forbidden alternate data stream."
    }
  }
  $fileStream = [System.IO.FileStream]::new(
    $fullPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    $Share
  )
  try {
    $identity = Get-ControlledFileIdentityFromStream -Stream $fileStream
    if ($RequireSingleLink -and [uint32]$identity.NumberOfLinks -ne 1) {
      throw "$Label must have exactly one hard-link reference."
    }
    return [pscustomobject]@{
      Path = $fullPath
      Stream = $fileStream
      Identity = $identity
      Sha256 = Get-ControlledStreamSha256 -Stream $fileStream
    }
  } catch {
    $fileStream.Dispose()
    throw
  }
}

function Remove-OwnedOutputFile {
  param(
    [string]$Path,
    [object]$ExpectedIdentity
  )

  if (-not $ExpectedIdentity -or -not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Owned output cleanup target is not a file: $Path"
  }
  $controlled = Open-VerifiedControlledFile `
    -Path $Path `
    -Share ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete) `
    -Label 'Owned output file'
  $primaryFailure = $null
  $disposeFailure = $null
  try {
    if (-not (Test-ControlledFileIdentityEqual -Left $controlled.Identity -Right $ExpectedIdentity)) {
      throw "Refusing to remove an output file owned by a different packager instance: $Path"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    $primaryFailure = $_
  }
  try {
    $controlled.Stream.Dispose()
  } catch {
    $disposeFailure = $_
  }
  if ($primaryFailure -and $disposeFailure) {
    try {
      Write-Warning "Owned output stream disposal also failed: $($disposeFailure.Exception.Message)" -WarningAction Continue
    } catch {
      # Never replace the output removal failure with a diagnostic failure.
    }
  }
  if ($primaryFailure) {
    throw $primaryFailure
  }
  if ($disposeFailure) {
    throw $disposeFailure
  }
}

function New-PackageOutputReservation {
  param(
    [string]$OutputRoot,
    [string]$PackageId,
    [string]$OwnerToken
  )

  Assert-PathHasNoReparsePointAncestorsForPackager -Path $OutputRoot
  $reservationPath = Join-Path $OutputRoot "$PackageId.reservation"
  $reservationIdentity = $null
  try {
    $stream = [System.IO.FileStream]::new(
      $reservationPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    $nativeErrorCode = $_.Exception.HResult -band 0xffff
    if (@(80, 183) -contains $nativeErrorCode) {
      throw "Formal package id is already reserved: $PackageId"
    }
    throw
  }
  try {
    $reservationIdentity = Get-ControlledFileIdentityFromStream -Stream $stream
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($OwnerToken)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    return [pscustomobject]@{
      Path = $reservationPath
      OwnerToken = $OwnerToken
      Stream = $stream
      Identity = $reservationIdentity
    }
  } catch {
    $primaryFailure = $_
    $secondaryFailures = New-Object 'System.Collections.Generic.List[string]'
    try {
      $stream.Dispose()
    } catch {
      [void]$secondaryFailures.Add("reservation stream disposal: $($_.Exception.Message)")
    }
    if ($reservationIdentity) {
      try {
        Remove-OwnedOutputFile -Path $reservationPath -ExpectedIdentity $reservationIdentity
      } catch {
        [void]$secondaryFailures.Add("reservation file cleanup: $($_.Exception.Message)")
      }
    }
    if ($secondaryFailures.Count -gt 0) {
      try {
        Write-Warning "Reservation creation cleanup also failed: $($secondaryFailures -join '; ')" -WarningAction Continue
      } catch {
        # Never replace the reservation creation failure with a diagnostic failure.
      }
    }
    throw $primaryFailure
  }
}

function Close-PackageOutputReservation {
  param([object]$Reservation)

  if (-not $Reservation) {
    return
  }
  $disposeFailure = $null
  $removeFailure = $null
  try {
    $Reservation.Stream.Dispose()
  } catch {
    $disposeFailure = $_
  }
  try {
    Remove-OwnedOutputFile `
      -Path ([string]$Reservation.Path) `
      -ExpectedIdentity $Reservation.Identity
  } catch {
    $removeFailure = $_
  }
  if ($disposeFailure -and $removeFailure) {
    try {
      Write-Warning "Reservation file cleanup also failed: $($removeFailure.Exception.Message)" -WarningAction Continue
    } catch {
      # Never replace the stream disposal failure with a diagnostic failure.
    }
  }
  if ($disposeFailure) {
    throw $disposeFailure
  }
  if ($removeFailure) {
    throw $removeFailure
  }
}

function New-WorkspacePackagingLease {
  param(
    [string]$ProjectRoot,
    [string]$OwnerToken
  )

  $leaseDirectory = Join-Path $ProjectRoot 'output'
  New-Item -ItemType Directory -Path $leaseDirectory -Force | Out-Null
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $leaseDirectory
  $leasePath = Join-Path $leaseDirectory '.nantong-full-runtime-hotfix-build.lock'
  if (Test-Path -LiteralPath $leasePath) {
    Assert-PathHasNoReparsePointAncestorsForPackager -Path $leasePath
    if (-not (Test-Path -LiteralPath $leasePath -PathType Leaf)) {
      throw 'Full-runtime hotfix packaging lease is not a file.'
    }
  }

  try {
    $stream = [System.IO.FileStream]::new(
      $leasePath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    $nativeErrorCode = $_.Exception.HResult -band 0xffff
    if (@(32, 33) -contains $nativeErrorCode) {
      throw 'Another full-runtime hotfix packaging process is already active for this project.'
    }
    throw
  }

  try {
    $identity = Get-ControlledFileIdentityFromStream -Stream $stream
    if ([uint32]$identity.NumberOfLinks -ne 1) {
      throw 'Full-runtime hotfix packaging lease must have exactly one hard-link reference.'
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($OwnerToken)
    $stream.SetLength(0)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    return [pscustomobject]@{
      Path = $leasePath
      Stream = $stream
      Identity = $identity
    }
  } catch {
    $stream.Dispose()
    throw
  }
}

function Close-WorkspacePackagingLease {
  param([object]$Lease)

  if ($Lease) {
    $Lease.Stream.Dispose()
  }
}

function Invoke-CleanBuildWorkspaceRobocopyFallback {
  param([string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $fullPath)).TrimEnd('\', '/')
  $leaf = Split-Path -Leaf $fullPath
  if (
    -not [string]::Equals($parent, $tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $leaf -cnotmatch '^nantong-hotfix-build-\d{8}-\d{6}-[0-9a-f]{32}$'
  ) {
    throw "Refusing to mirror an unexpected clean-build workspace: $fullPath"
  }
  if (-not (Test-Path -LiteralPath $fullPath)) {
    return
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
    throw "Clean-build workspace fallback target is not a directory: $fullPath"
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath

  $systemDirectory = [Environment]::SystemDirectory
  if ([string]::IsNullOrWhiteSpace($systemDirectory)) {
    throw 'Windows system directory is unavailable for clean-build workspace cleanup.'
  }
  $robocopyPath = [System.IO.Path]::Combine($systemDirectory, 'robocopy.exe')
  if (-not (Test-Path -LiteralPath $robocopyPath -PathType Leaf)) {
    throw "Trusted robocopy executable is unavailable: $robocopyPath"
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $robocopyPath

  $emptyLeaf = "nantong-hotfix-cleanup-empty-$([guid]::NewGuid().ToString('N'))"
  $emptyRoot = [System.IO.Path]::Combine($tempRoot, $emptyLeaf)
  $emptyCreated = $false
  $primaryFailure = $null
  $emptyCleanupFailure = $null
  try {
    if (Test-Path -LiteralPath $emptyRoot) {
      throw "Clean-build cleanup source already exists: $emptyRoot"
    }
    [void][System.IO.Directory]::CreateDirectory($emptyRoot)
    $emptyCreated = $true
    $emptyParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $emptyRoot)).TrimEnd('\', '/')
    if (
      -not [string]::Equals($emptyParent, $tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $emptyRoot) -cnotmatch '^nantong-hotfix-cleanup-empty-[0-9a-f]{32}$' -or
      -not (Test-Path -LiteralPath $emptyRoot -PathType Container)
    ) {
      throw "Clean-build cleanup source failed boundary validation: $emptyRoot"
    }
    Assert-PathHasNoReparsePointAncestorsForPackager -Path $emptyRoot
    if (@(Get-ChildItem -LiteralPath $emptyRoot -Force -ErrorAction Stop).Count -ne 0) {
      throw "Clean-build cleanup source is not empty: $emptyRoot"
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $previousLastExitCodeVariable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $hadPreviousLastExitCode = $null -ne $previousLastExitCodeVariable
    $previousLastExitCode = if ($hadPreviousLastExitCode) { $previousLastExitCodeVariable.Value } else { $null }
    $robocopyInvocationFailure = $null
    $robocopyExitCode = $null
    try {
      $ErrorActionPreference = 'Continue'
      if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Clean-build workspace fallback target disappeared or changed type: $fullPath"
      }
      Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath
      Assert-PathHasNoReparsePointAncestorsForPackager -Path $emptyRoot
      if (@(Get-ChildItem -LiteralPath $emptyRoot -Force -ErrorAction Stop).Count -ne 0) {
        throw "Clean-build cleanup source changed before robocopy: $emptyRoot"
      }
      $global:LASTEXITCODE = $null
      & $robocopyPath `
        $emptyRoot `
        $fullPath `
        '/MIR' `
        '/XJ' `
        '/R:0' `
        '/W:0' `
        '/NFL' `
        '/NDL' `
        '/NJH' `
        '/NJS' `
        '/NP' 1>$null 2>$null
      if ($null -ne $global:LASTEXITCODE) {
        $robocopyExitCode = [int]$global:LASTEXITCODE
      }
    } catch {
      $robocopyInvocationFailure = $_
    } finally {
      if ($hadPreviousLastExitCode) {
        $global:LASTEXITCODE = $previousLastExitCode
      } else {
        Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
      }
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($robocopyInvocationFailure) {
      throw $robocopyInvocationFailure
    }
    if ($null -eq $robocopyExitCode -or $robocopyExitCode -lt 0 -or $robocopyExitCode -gt 7) {
      $exitDescription = if ($null -eq $robocopyExitCode) { 'missing' } else { [string]$robocopyExitCode }
      throw "Clean-build workspace robocopy fallback failed with exit code $exitDescription."
    }

    if (Test-Path -LiteralPath $fullPath) {
      if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Clean-build workspace fallback target changed type: $fullPath"
      }
      Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath
      $remainingEntries = @(Get-ChildItem -LiteralPath $fullPath -Force -ErrorAction Stop)
      if ($remainingEntries.Count -ne 0) {
        throw "Clean-build workspace robocopy fallback left $($remainingEntries.Count) root entries."
      }
      [System.IO.Directory]::Delete($fullPath, $false)
    }
    if (Test-Path -LiteralPath $fullPath) {
      throw "Clean-build workspace still exists after robocopy fallback: $fullPath"
    }
  } catch {
    $primaryFailure = $_
  } finally {
    if ($emptyCreated) {
      try {
        if (Test-Path -LiteralPath $emptyRoot) {
          Assert-PathHasNoReparsePointAncestorsForPackager -Path $emptyRoot
          $emptyEntries = @(Get-ChildItem -LiteralPath $emptyRoot -Force -ErrorAction Stop)
          if ($emptyEntries.Count -ne 0) {
            throw "Clean-build cleanup source is no longer empty: $emptyRoot"
          }
          [System.IO.Directory]::Delete($emptyRoot, $false)
        }
      } catch {
        $emptyCleanupFailure = $_
      }
    }
  }
  if ($primaryFailure) {
    if ($emptyCleanupFailure) {
      throw [System.InvalidOperationException]::new(
        "$($primaryFailure.Exception.Message) Cleanup source removal also failed: $($emptyCleanupFailure.Exception.Message)",
        $primaryFailure.Exception
      )
    }
    throw $primaryFailure
  }
  if ($emptyCleanupFailure) {
    throw $emptyCleanupFailure
  }
}

function Remove-CleanBuildWorkspace {
  param(
    [string]$Path,
    [int]$MaxAttempts = 10
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $fullPath)).TrimEnd('\', '/')
  $leaf = Split-Path -Leaf $fullPath
  if (
    -not [string]::Equals($parent, $tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $leaf -cnotmatch '^nantong-hotfix-build-\d{8}-\d{6}-[0-9a-f]{32}$'
  ) {
    throw "Refusing to remove an unexpected clean-build workspace: $fullPath"
  }
  if ($MaxAttempts -lt 1 -or $MaxAttempts -gt 10) {
    throw 'Clean-build workspace cleanup retry count is invalid.'
  }
  if (
    (Test-Path -LiteralPath $fullPath) -and
    -not (Test-Path -LiteralPath $fullPath -PathType Container)
  ) {
    throw "Clean-build workspace cleanup target is not a directory: $fullPath"
  }

  $lastFailure = $null
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-Path -LiteralPath $fullPath)) {
      return
    }
    Assert-PathHasNoReparsePointAncestorsForPackager -Path $fullPath
    try {
      Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop
    } catch {
      $lastFailure = $_
    }
    if (-not (Test-Path -LiteralPath $fullPath)) {
      return
    }
    if ($attempt -lt $MaxAttempts) {
      Start-Sleep -Milliseconds ([Math]::Min(250 * $attempt, 1000))
    }
  }
  $reason = if ($lastFailure) { $lastFailure.Exception.Message } else { 'workspace still exists' }
  try {
    Invoke-CleanBuildWorkspaceRobocopyFallback -Path $fullPath
    return
  } catch {
    $fallbackFailure = $_
  }
  if ($lastFailure) {
    throw [System.InvalidOperationException]::new(
      "Clean-build workspace cleanup failed after $MaxAttempts attempts: $reason Robocopy fallback failed: $($fallbackFailure.Exception.Message)",
      $lastFailure.Exception
    )
  }
  throw "Clean-build workspace cleanup failed after $MaxAttempts attempts: $reason Robocopy fallback failed: $($fallbackFailure.Exception.Message)"
}

function Remove-OwnedOutputFileWithRetry {
  param(
    [string]$Path,
    [object]$ExpectedIdentity,
    [string]$Label,
    [int]$MaxAttempts = 10
  )

  if (-not $ExpectedIdentity) {
    return
  }
  if ($MaxAttempts -lt 1 -or $MaxAttempts -gt 20) {
    throw 'Owned output cleanup retry count is invalid.'
  }
  $lastFailure = $null
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      throw "Owned output cleanup target is not a file: $Path"
    }
    try {
      Remove-OwnedOutputFile -Path $Path -ExpectedIdentity $ExpectedIdentity
    } catch {
      $lastFailure = $_
      if ($_.Exception.Message -like 'Refusing to remove an output file owned by a different packager instance:*') {
        throw
      }
    }
    if (-not (Test-Path -LiteralPath $Path)) {
      return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      throw "Owned output cleanup target is not a file: $Path"
    }
    if ($attempt -lt $MaxAttempts) {
      Start-Sleep -Milliseconds ([Math]::Min(250 * $attempt, 1000))
    }
  }
  $reason = if ($lastFailure) { $lastFailure.Exception.Message } else { 'owned output file still exists' }
  throw "$Label cleanup failed after $MaxAttempts attempts: $reason"
}

function Publish-AtomicFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    throw "Formal candidate path already exists: $Destination"
  }
  $MOVEFILE_WRITE_THROUGH = 0x00000008
  if (-not [NantongHotfixPackagerNativeMethods]::MoveFileEx($Source, $Destination, $MOVEFILE_WRITE_THROUGH)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Atomic formal-candidate promotion failed with Win32 error $errorCode."
  }
}

function New-HotfixArchiveFromDirectory {
  param(
    [string]$StageRoot,
    [string]$ArchivePath,
    [object[]]$ExpectedEntries
  )

  $stageRootFull = [System.IO.Path]::GetFullPath($StageRoot).TrimEnd('\', '/')
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $stageRootFull
  $archiveStream = [System.IO.FileStream]::new(
    $ArchivePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  $archiveIdentity = $null
  try {
    $archiveIdentity = Get-ControlledFileIdentityFromStream -Stream $archiveStream
    if ([uint32]$archiveIdentity.NumberOfLinks -ne 1) {
      throw 'New partial ZIP must have exactly one hard-link reference.'
    }
    $archive = [System.IO.Compression.ZipArchive]::new(
      $archiveStream,
      [System.IO.Compression.ZipArchiveMode]::Create,
      $true
    )
    try {
      foreach ($expectedEntry in @($ExpectedEntries | Sort-Object { Get-PathSortKey -Path ([string]$_.path) })) {
        [void](Assert-CanonicalRelativePath -RelativePath ([string]$expectedEntry.path))
        $relativePath = [string]$expectedEntry.path
        $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $stageRootFull $relativePath))
        $expectedPrefix = $stageRootFull + [System.IO.Path]::DirectorySeparatorChar
        if (-not $sourcePath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Archive source escapes the verified stage: $relativePath"
        }
        $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
        if ([int64]$sourceItem.Length -ne [int64]$expectedEntry.size) {
          throw "Archive source size changed before compression: $relativePath"
        }
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceHash -cne [string]$expectedEntry.sha256) {
          throw "Archive source hash changed before compression: $relativePath"
        }
        $zipEntry = $archive.CreateEntry(
          $relativePath,
          [System.IO.Compression.CompressionLevel]::Optimal
        )
        $sourceStream = [System.IO.FileStream]::new(
          $sourcePath,
          [System.IO.FileMode]::Open,
          [System.IO.FileAccess]::Read,
          [System.IO.FileShare]::Read
        )
        $entryStream = $zipEntry.Open()
        try {
          $sourceStream.CopyTo($entryStream)
        } finally {
          $entryStream.Dispose()
          $sourceStream.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
    $archiveStream.Flush($true)
    return $archiveIdentity
  } catch {
    $failure = $_
    $archiveStream.Dispose()
    $archiveStream = $null
    if ($archiveIdentity) {
      try {
        Remove-OwnedOutputFile -Path $ArchivePath -ExpectedIdentity $archiveIdentity
      } catch {
        # Preserve an unexpectedly replaced path.
      }
    }
    throw $failure
  } finally {
    if ($archiveStream) {
      $archiveStream.Dispose()
    }
  }
}

function Prepare-VerifiedHotfixArchive {
  param(
    [string]$PartialZipPath,
    [string]$ZipPath,
    [string]$PartialShaPath,
    [object[]]$ExpectedEntries,
    [object]$ExpectedPartialZipIdentity,
    [int64]$MaxArchiveBytes,
    [int64]$MaxUncompressedBytes,
    [scriptblock]$AfterZipMoveHook
  )

  $partialZip = $null
  $publishedZip = $null
  $partialSha = $null
  $partialZipIdentity = $null
  $partialShaIdentity = $null
  $publishedZipIdentity = $null
  $zipWasMoved = $false
  try {
    Assert-ReopenedHotfixArchive `
      -ArchivePath $PartialZipPath `
      -ExpectedEntries $ExpectedEntries `
      -MaxArchiveBytes $MaxArchiveBytes `
      -MaxUncompressedBytes $MaxUncompressedBytes
    $partialZip = Open-VerifiedControlledFile `
      -Path $PartialZipPath `
      -Share ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete) `
      -RequireSingleLink `
      -Label 'Partial ZIP candidate'
    $partialZipIdentity = $partialZip.Identity
    if (
      $ExpectedPartialZipIdentity -and
      -not (Test-ControlledFileIdentityEqual -Left $partialZipIdentity -Right $ExpectedPartialZipIdentity)
    ) {
      throw 'Partial ZIP identity changed after controlled creation.'
    }
    $archiveHash = Get-ControlledStreamSha256 -Stream $partialZip.Stream

    Publish-AtomicFile -Source $PartialZipPath -Destination $ZipPath
    $zipWasMoved = $true
    if ($AfterZipMoveHook) {
      & $AfterZipMoveHook $ZipPath
    }
    $publishedZip = Open-VerifiedControlledFile `
      -Path $ZipPath `
      -Share ([System.IO.FileShare]::Read) `
      -RequireSingleLink `
      -Label 'Published ZIP candidate'
    if (-not (Test-ControlledFileIdentityEqual -Left $partialZip.Identity -Right $publishedZip.Identity)) {
      throw 'Published ZIP identity changed before verification.'
    }
    $publishedZipIdentity = $publishedZip.Identity
    $partialZip.Stream.Dispose()
    $partialZip = $null

    Assert-ReopenedHotfixArchive `
      -ArchivePath $ZipPath `
      -ExpectedEntries $ExpectedEntries `
      -MaxArchiveBytes $MaxArchiveBytes `
      -MaxUncompressedBytes $MaxUncompressedBytes
    $publishedArchiveHash = Get-ControlledStreamSha256 -Stream $publishedZip.Stream
    if ($publishedArchiveHash -cne $archiveHash) {
      throw 'Published ZIP hash changed before verification.'
    }

    $readyMarkerBytes = [System.Text.Encoding]::ASCII.GetBytes(
      "$($archiveHash.ToUpperInvariant())  $([System.IO.Path]::GetFileName($ZipPath))$([Environment]::NewLine)"
    )
    $partialShaStream = [System.IO.FileStream]::new(
      $PartialShaPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete)
    )
    $partialShaIdentity = Get-ControlledFileIdentityFromStream -Stream $partialShaStream
    $partialSha = [pscustomobject]@{
      Path = $PartialShaPath
      Stream = $partialShaStream
      Identity = $partialShaIdentity
      Sha256 = $null
    }
    try {
      $partialShaStream.Write($readyMarkerBytes, 0, $readyMarkerBytes.Length)
      $partialShaStream.Flush($true)
      $partialSha.Sha256 = Get-ControlledStreamSha256 -Stream $partialShaStream
      if ([uint32]$partialShaIdentity.NumberOfLinks -ne 1) {
        throw 'Partial SHA ready marker must have exactly one hard-link reference.'
      }
    } catch {
      $partialShaStream.Dispose()
      throw
    }
    $partialShaHash = [string]$partialSha.Sha256
    $publishedZip.Stream.Dispose()
    $publishedZip = $null
    $partialSha.Stream.Dispose()
    $partialSha = $null
    return [pscustomobject]@{
      ArchiveHash = $archiveHash.ToUpperInvariant()
      ZipIdentity = $publishedZipIdentity
      PartialShaIdentity = $partialShaIdentity
      PartialShaHash = $partialShaHash
    }
  } catch {
    $failure = $_
    $cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
    if ($publishedZip) {
      try {
        $publishedZip.Stream.Dispose()
      } catch {
        [void]$cleanupFailures.Add("published ZIP stream: $($_.Exception.Message)")
      }
      $publishedZip = $null
    }
    if ($partialZip) {
      try {
        $partialZip.Stream.Dispose()
      } catch {
        [void]$cleanupFailures.Add("partial ZIP stream: $($_.Exception.Message)")
      }
      $partialZip = $null
    }
    if ($partialSha) {
      try {
        $partialSha.Stream.Dispose()
      } catch {
        [void]$cleanupFailures.Add("partial SHA stream: $($_.Exception.Message)")
      }
      $partialSha = $null
    }
    $ownedZipPath = if ($zipWasMoved) { $ZipPath } else { $PartialZipPath }
    if ($partialZipIdentity -and (Test-Path -LiteralPath $ownedZipPath -PathType Leaf)) {
      try {
        Remove-OwnedOutputFileWithRetry `
          -Path $ownedZipPath `
          -ExpectedIdentity $partialZipIdentity `
          -Label 'prepared ZIP'
      } catch {
        [void]$cleanupFailures.Add("prepared ZIP: $($_.Exception.Message)")
      }
    }
    if ($partialShaIdentity -and (Test-Path -LiteralPath $PartialShaPath -PathType Leaf)) {
      try {
        Remove-OwnedOutputFileWithRetry `
          -Path $PartialShaPath `
          -ExpectedIdentity $partialShaIdentity `
          -Label 'partial SHA ready marker'
      } catch {
        [void]$cleanupFailures.Add("partial SHA ready marker: $($_.Exception.Message)")
      }
    }
    if ($cleanupFailures.Count -gt 0) {
      try {
        Write-Warning "Archive preparation cleanup also failed: $($cleanupFailures -join '; ')" -WarningAction Continue
      } catch {
        # Never replace the archive preparation failure with a diagnostic failure.
      }
    }
    throw $failure
  }
}

function Publish-VerifiedReadyMarker {
  param(
    [string]$PartialShaPath,
    [string]$ShaPath,
    [object]$ExpectedPartialShaIdentity,
    [string]$ExpectedPartialShaHash,
    [string]$ZipPath,
    [object]$ExpectedZipIdentity,
    [string]$ExpectedArchiveHash,
    [object[]]$ExpectedEntries,
    [int64]$MaxArchiveBytes,
    [int64]$MaxUncompressedBytes
  )

  Assert-ReopenedHotfixArchive `
    -ArchivePath $ZipPath `
    -ExpectedEntries $ExpectedEntries `
    -MaxArchiveBytes $MaxArchiveBytes `
    -MaxUncompressedBytes $MaxUncompressedBytes
  $verifiedZip = Open-VerifiedControlledFile `
    -Path $ZipPath `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Prepared ZIP candidate'
  try {
    if (-not (Test-ControlledFileIdentityEqual -Left $verifiedZip.Identity -Right $ExpectedZipIdentity)) {
      throw 'Prepared ZIP identity changed before ready-marker commit.'
    }
    if ((Get-ControlledStreamSha256 -Stream $verifiedZip.Stream) -cne $ExpectedArchiveHash.ToLowerInvariant()) {
      throw 'Prepared ZIP hash changed before ready-marker commit.'
    }
  } finally {
    $verifiedZip.Stream.Dispose()
  }

  $verifiedMarker = Open-VerifiedControlledFile `
    -Path $PartialShaPath `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Partial SHA ready marker'
  try {
    if (-not (Test-ControlledFileIdentityEqual -Left $verifiedMarker.Identity -Right $ExpectedPartialShaIdentity)) {
      throw 'Partial SHA ready-marker identity changed before commit.'
    }
    if ((Get-ControlledStreamSha256 -Stream $verifiedMarker.Stream) -cne $ExpectedPartialShaHash.ToLowerInvariant()) {
      throw 'Partial SHA ready-marker hash changed before commit.'
    }
  } finally {
    $verifiedMarker.Stream.Dispose()
  }

  Publish-AtomicFile -Source $PartialShaPath -Destination $ShaPath
}

function Assert-ReleaseToolUnchanged {
  param(
    [string]$Path,
    [string]$ExpectedSha256,
    [object]$ExpectedIdentity
  )

  $controlled = Open-VerifiedControlledFile `
    -Path $Path `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Release packaging tool'
  try {
    if (
      [string]$controlled.Sha256 -cne $ExpectedSha256 -or
      ($ExpectedIdentity -and -not (Test-ControlledFileIdentityEqual -Left $controlled.Identity -Right $ExpectedIdentity))
    ) {
      throw 'Release tool changed after code freeze.'
    }
  } finally {
    $controlled.Stream.Dispose()
  }
}

function Assert-BaselineExportSourceUnchanged {
  param(
    [string]$SourceExportRoot,
    [object]$InitialExport,
    [string]$InitialManifestSha256
  )

  $currentExport = Assert-BaselineExportManifest -ExportRoot $SourceExportRoot
  $currentManifestSha256 = (Get-FileHash `
    -LiteralPath (Join-Path $SourceExportRoot 'server-baseline-manifest.json') `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (
    $currentManifestSha256 -cne $InitialManifestSha256 -or
    [string]$currentExport.Manifest.baselineFingerprint -cne [string]$InitialExport.Manifest.baselineFingerprint -or
    [string]$currentExport.Manifest.exportPlanFingerprint -cne [string]$InitialExport.Manifest.exportPlanFingerprint
  ) {
    throw 'Server baseline export changed after initial verification.'
  }
  return $currentExport
}

function New-VerifiedBaselineSnapshot {
  param(
    [string]$SourceExportRoot,
    [string]$DestinationExportRoot,
    [object]$InitialExport,
    [string]$InitialManifestSha256
  )

  if (Test-Path -LiteralPath $DestinationExportRoot) {
    throw "Baseline snapshot path already exists: $DestinationExportRoot"
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $SourceExportRoot
  foreach ($sourceItem in @(
    Get-Item -LiteralPath (Join-Path $SourceExportRoot 'server-baseline-manifest.json') -Force -ErrorAction Stop
  ) + @(
    Get-Item -LiteralPath (Join-Path $SourceExportRoot 'baseline') -Force -ErrorAction Stop
  ) + @(
    Get-ChildItem -LiteralPath (Join-Path $SourceExportRoot 'baseline') -Force -Recurse
  )) {
    Assert-SnapshotSourceItem -Path $sourceItem.FullName
  }

  New-Item -ItemType Directory -Path $DestinationExportRoot | Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $SourceExportRoot 'server-baseline-manifest.json') `
    -Destination (Join-Path $DestinationExportRoot 'server-baseline-manifest.json')
  Copy-Item `
    -LiteralPath (Join-Path $SourceExportRoot 'baseline') `
    -Destination (Join-Path $DestinationExportRoot 'baseline') `
    -Recurse

  $snapshotExport = Assert-BaselineExportManifest -ExportRoot $DestinationExportRoot
  $snapshotManifestSha256 = (Get-FileHash `
    -LiteralPath (Join-Path $DestinationExportRoot 'server-baseline-manifest.json') `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (
    $snapshotManifestSha256 -cne $InitialManifestSha256 -or
    [string]$snapshotExport.Manifest.baselineFingerprint -cne [string]$InitialExport.Manifest.baselineFingerprint -or
    [string]$snapshotExport.Manifest.exportPlanFingerprint -cne [string]$InitialExport.Manifest.exportPlanFingerprint
  ) {
    throw 'Verified server baseline snapshot does not match the initial export proof.'
  }
  [void](Assert-BaselineExportSourceUnchanged `
    -SourceExportRoot $SourceExportRoot `
    -InitialExport $InitialExport `
    -InitialManifestSha256 $InitialManifestSha256)
  return $snapshotExport
}

$workspacePackagingLease = $null
try {
  if (-not $ValidateBaselineOnly) {
    $workspacePackagingLease = New-WorkspacePackagingLease `
      -ProjectRoot $projectRoot `
      -OwnerToken $ownerToken
  }

  $releaseToolControlAtStart = Open-VerifiedControlledFile `
    -Path $releaseToolPath `
    -Share ([System.IO.FileShare]::Read) `
    -RequireSingleLink `
    -Label 'Release packaging tool'
  try {
    if ([string]$releaseToolControlAtStart.Sha256 -cne $releaseToolFingerprintAtStart) {
      throw 'Release tool changed during initial code freeze.'
    }
    $releaseToolIdentityAtStart = $releaseToolControlAtStart.Identity
  } finally {
    $releaseToolControlAtStart.Stream.Dispose()
  }
  if (-not $ValidateBaselineOnly) {
    $baselineGateControlAtStart = Open-VerifiedControlledFile `
      -Path $baselineGateToolPath `
      -Share ([System.IO.FileShare]::Read) `
      -RequireSingleLink `
      -Label 'Production baseline gate'
    try {
      if ([string]$baselineGateControlAtStart.Sha256 -cne $baselineGateToolFingerprintAtStart) {
        throw 'Production baseline gate changed during initial code freeze.'
      }
      $baselineGateToolIdentityAtStart = $baselineGateControlAtStart.Identity
      & $baselineGateToolPath `
        -BaselineManifestPath (Join-Path $baselineExportRootPath 'server-baseline-manifest.json') `
        -ProductionReleaseStatePath (Join-Path $projectRoot 'docs\engineering\production-release-state.json') `
        -ProductionPackageRoot (Join-Path $projectRoot 'output\hotfix')
    } finally {
      $baselineGateControlAtStart.Stream.Dispose()
    }
    Assert-ReleaseToolUnchanged `
      -Path $baselineGateToolPath `
      -ExpectedSha256 $baselineGateToolFingerprintAtStart `
      -ExpectedIdentity $baselineGateToolIdentityAtStart
  }
  $baselineExportInitial = Assert-BaselineExportManifest -ExportRoot $baselineExportRootPath
  $baselineExportSourceManifestShaAtStart = (Get-FileHash `
    -LiteralPath (Join-Path $baselineExportRootPath 'server-baseline-manifest.json') `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($ValidateBaselineOnly) {
    [ordered]@{
      success = $true
      schemaVersion = [int]$baselineExportInitial.Manifest.schemaVersion
      fileCount = [int]$baselineExportInitial.Manifest.fileCount
      metadataOnlyFileCount = [int]$baselineExportInitial.Manifest.nonExportedRuntimeFileCount
    } | ConvertTo-Json -Compress
    return
  }
} catch {
  $preflightFailure = $_
  try {
    Close-WorkspacePackagingLease -Lease $workspacePackagingLease
  } catch {
    try {
      Write-Warning "Workspace packaging lease release also failed: $($_.Exception.Message)" -WarningAction Continue
    } catch {
      # Never replace the preflight failure with a diagnostic failure.
    }
  }
  throw $preflightFailure
}

$runtimeRoots = @('dist\server', 'dist\shared', 'dist\client')
$baseFileSources = [ordered]@{
  'package.json' = 'package.json'
  'package-lock.json' = 'package-lock.json'
  'start.ps1' = 'deploy/start.ps1'
  'start.cmd' = 'deploy/start.cmd'
}
$releaseFileSources = [ordered]@{
  '.feishu-card-action-consumer-release' = '.feishu-card-action-consumer-release'
  'watchdog.ps1' = 'deploy/watchdog.ps1'
  'scripts/run-with-env.mjs' = 'scripts/run-with-env.mjs'
  'scripts/verify-hotfix-activation.cjs' = 'scripts/verify-hotfix-activation.cjs'
  'scripts/remove-legacy-contract-ocr.ps1' = 'scripts/remove-legacy-contract-ocr.ps1'
  'scripts/ensure-feishu-card-ws-sdk-patch.mjs' = 'scripts/ensure-feishu-card-ws-sdk-patch.mjs'
  'scripts/postinstall.mjs' = 'scripts/postinstall.mjs'
  'scripts/ensure-overtime-workflow-fields.mjs' = 'scripts/ensure-overtime-workflow-fields.mjs'
  'scripts/ensure-purchase-inventory-config.mjs' = 'scripts/ensure-purchase-inventory-config.mjs'
  'scripts/verify-contract-storage-startup.mjs' = 'scripts/verify-contract-storage-startup.mjs'
  'scripts/verify-feishu-access-startup.mjs' = 'scripts/verify-feishu-access-startup.mjs'
  'scripts/install-contract-preview-python-deps.ps1' = 'scripts/install-contract-preview-python-deps.ps1'
  'scripts/requirements-contract-preview.txt' = 'scripts/requirements-contract-preview.txt'
  'scripts/weekly-report/bridge.py' = 'scripts/weekly-report/bridge.py'
  'scripts/weekly-report/nantong_weekly_report.py' = 'scripts/weekly-report/nantong_weekly_report.py'
  'scripts/weekly-report/env_loader.py' = 'scripts/weekly-report/env_loader.py'
  'scripts/weekly-report/native_feishu.py' = 'scripts/weekly-report/native_feishu.py'
  'scripts/ensure-inventory-outbound-approval-fields.mjs' = 'scripts/ensure-inventory-outbound-approval-fields.mjs'
  'scripts/ensure-leave-workflow-fields.mjs' = 'scripts/ensure-leave-workflow-fields.mjs'
  'scripts/migrate-leave-shift-substitute-details.mjs' = 'scripts/migrate-leave-shift-substitute-details.mjs'
  'scripts/dingtalk-attendance-cli.mjs' = 'scripts/dingtalk-attendance-cli.mjs'
  'scripts/backfill-dingtalk-attendance-archive.mjs' = 'scripts/backfill-dingtalk-attendance-archive.mjs'
  'scripts/ensure-attendance-archive-summary-fields.mjs' = 'scripts/ensure-attendance-archive-summary-fields.mjs'
  'scripts/migrate-legacy-exception-follow-ups.mjs' = 'scripts/migrate-legacy-exception-follow-ups.mjs'
  'scripts/ensure-today-operations-follow-up-fields.mjs' = 'scripts/ensure-today-operations-follow-up-fields.mjs'
  'scripts/migrate-dingtalk-attendance-credentials.ps1' = 'scripts/migrate-dingtalk-attendance-credentials.ps1'
  'scripts/reset-all-access-passwords.cmd' = 'scripts/reset-all-access-passwords.cmd'
  'scripts/reset-all-access-passwords.ps1' = 'scripts/reset-all-access-passwords.ps1'
  'scripts/reset-all-access-passwords.mjs' = 'scripts/reset-all-access-passwords.mjs'
  'package.json' = 'package.json'
  'package-lock.json' = 'package-lock.json'
  'start.ps1' = 'deploy/start.ps1'
  'start.cmd' = 'deploy/start.cmd'
  'stop.ps1' = 'deploy/stop.ps1'
}
$baselinePreservedReleaseTargets = @(
  '.feishu-card-action-consumer-release'
)
$releaseSourceFileAllowlist = @(
  $releaseFileSources.Values |
    Where-Object { $baselinePreservedReleaseTargets -notcontains $_ }
)
$supportSourceFiles = @(
  'deploy/hotfix-recovery-start.ps1',
  'scripts/verify-hotfix-dependency-transition.mjs',
  'scripts/verify-client-asset-graph.mjs',
  'scripts/run-with-env.mjs',
  'scripts/ensure-inventory-outbound-approval-fields.mjs',
  'scripts/ensure-leave-workflow-fields.mjs',
  'scripts/migrate-leave-shift-substitute-details.mjs',
  'scripts/self-test-leave-workflow.mjs',
  'docs/runbooks/leave-workflow-multi-shift-substitute.md'
)
$buildDirectoryAllowlist = @('client', 'server', 'shared')
$buildFileAllowlist = @(
  'package.json',
  'package-lock.json',
  'nest-cli.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'rspack.config.js',
  'rspack.overtime-confirmation.config.js',
  'postcss.config.js',
  'tailwind.config.ts',
  'scripts/postinstall.mjs',
  'scripts/ensure-feishu-card-ws-sdk-patch.mjs',
  'scripts/verify-hotfix-dependency-transition.mjs',
  'scripts/verify-production-runtime-closure.mjs',
  'scripts/write-hotfix-runtime-identity.cjs',
  'scripts/verify-client-asset-graph.mjs',
  'scripts/verify-hotfix-smoke-preflight.mjs',
  'scripts/prepare-hotfix-smoke-standby.ps1',
  'scripts/run-hotfix-smoke-with-feishu-credentials.mjs',
  'scripts/verify-reused-build-toolchain.mjs',
  'scripts/assert-current-production-baseline.ps1',
  'scripts/export-server-hotfix-baseline.ps1',
  'scripts/create-safe-full-runtime-hotfix-package.ps1'
) + $releaseSourceFileAllowlist + $supportSourceFiles |
  Select-Object -Unique

$cleanBuildWorkspaceRoot = Join-Path ([System.IO.Path]::GetTempPath()) "nantong-hotfix-build-$timestamp-$([Guid]::NewGuid().ToString('N'))"
$selectedBuildSourceRoot = Resolve-BuildSourceRoot -ProjectRoot $projectRoot -SelectedRoot $BuildSourceRoot
$cleanBuildSnapshotRoot = Join-Path (Join-Path $projectRoot 'output') ".nantong-hotfix-build-source-$timestamp-$ownerToken"
$stageRoot = Join-Path $cleanBuildWorkspaceRoot 'archive-stage'
$baselineSnapshotExportRoot = Join-Path $cleanBuildWorkspaceRoot 'verified-baseline-export'
$buildEnvironmentNpmrc = Join-Path $cleanBuildWorkspaceRoot 'sanitized-build.npmrc'
$workspaceDistPath = Join-Path $projectRoot 'dist'
$packageCompleted = $false
$packagingFailure = $null
$cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
$outputReservation = $null
$buildTools = $null
$archiveHash = $null
$publishedZipIdentity = $null
$partialShaOwnedIdentity = $null
$partialShaOwnedHash = $null
$partialZipOwnedIdentity = $null
try {
  New-Item -ItemType Directory -Path $outputRootPath -Force | Out-Null
  $outputReservation = New-PackageOutputReservation `
    -OutputRoot $outputRootPath `
    -PackageId $packageId `
    -OwnerToken $ownerToken
  foreach ($formalPath in @($zipPath, $shaPath, $partialZipPath, $partialShaPath)) {
    if (Test-Path -LiteralPath $formalPath) {
      throw "Formal candidate path already exists: $formalPath"
    }
  }

  New-Item -ItemType Directory -Path $cleanBuildWorkspaceRoot | Out-Null
  Set-Content -LiteralPath $buildEnvironmentNpmrc -Value '' -Encoding ascii
  Set-Content -LiteralPath "$buildEnvironmentNpmrc.global" -Value '' -Encoding ascii
  $buildTools = Resolve-VerifiedBuildTools -NodePath $BuildNodePath -NpmPath $BuildNpmPath
  $reusedProductionNodeModulesRoot = Resolve-VerifiedProductionNodeModulesRoot `
    -Path $VerifiedProductionNodeModulesRoot `
    -ExpectedProjectRoot $projectRoot
  Assert-ReusedProductionFeishuSdkPatch -NodeModulesRoot $reusedProductionNodeModulesRoot
  $baselineExport = New-VerifiedBaselineSnapshot `
    -SourceExportRoot $baselineExportRootPath `
    -DestinationExportRoot $baselineSnapshotExportRoot `
    -InitialExport $baselineExportInitial `
    -InitialManifestSha256 $baselineExportSourceManifestShaAtStart
  $baselineRootPath = [string]$baselineExport.BaselineRoot
  $baselineExportManifest = $baselineExport.Manifest
  $baselinePackageJsonPath = Join-Path $baselineRootPath 'package.json'
  $baselinePackageLockPath = Join-Path $baselineRootPath 'package-lock.json'
  foreach ($baselineDependencyFile in @($baselinePackageJsonPath, $baselinePackageLockPath)) {
    if (-not (Test-Path -LiteralPath $baselineDependencyFile -PathType Leaf)) {
      throw "Required server baseline dependency manifest is missing: $([System.IO.Path]::GetFileName($baselineDependencyFile))"
    }
  }

  $workspaceDistFingerprintBefore = Get-DirectoryStateFingerprint -Path $workspaceDistPath
  $sourceSnapshotFingerprintBefore = Get-SourceSnapshotFingerprint `
    -Root $selectedBuildSourceRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  New-CleanBuildSnapshot `
    -SourceRoot $selectedBuildSourceRoot `
    -DestinationRoot $cleanBuildSnapshotRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  $copiedSourceFingerprint = Get-SourceSnapshotFingerprint `
    -Root $cleanBuildSnapshotRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  $sourceSnapshotFingerprintAfter = Get-SourceSnapshotFingerprint `
    -Root $selectedBuildSourceRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  if (
    $sourceSnapshotFingerprintBefore -cne $sourceSnapshotFingerprintAfter -or
    $sourceSnapshotFingerprintBefore -cne $copiedSourceFingerprint
  ) {
    throw 'Source changed while the clean-build snapshot was being frozen.'
  }
  Assert-ReleaseToolUnchanged `
    -Path $baselineGateToolPath `
    -ExpectedSha256 $baselineGateToolFingerprintAtStart `
    -ExpectedIdentity $baselineGateToolIdentityAtStart

  $frozenCandidatePackageSha256 = (Get-FileHash `
    -LiteralPath (Join-Path $cleanBuildSnapshotRoot 'package.json') `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $frozenCandidatePackageLockSha256 = (Get-FileHash `
    -LiteralPath (Join-Path $cleanBuildSnapshotRoot 'package-lock.json') `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'The per-user dependency proof cache directory is unavailable.'
  }
  $dependencyProofCacheDirectory = Join-Path $env:LOCALAPPDATA 'NantongSchedule\dependency-proof-cache'
  if (-not (Test-Path -LiteralPath $dependencyProofCacheDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $dependencyProofCacheDirectory -Force | Out-Null
  }
  Assert-PathHasNoReparsePointAncestorsForPackager -Path $dependencyProofCacheDirectory
  $applicationRootCacheKey = Get-TextSha256 -Text ([System.IO.Path]::GetFullPath($projectRoot).TrimEnd('\').ToLowerInvariant())
  $dependencyProofCachePath = Join-Path $dependencyProofCacheDirectory "dependency-proof-$applicationRootCacheKey.json"
  $dependencyGateScript = Join-Path $cleanBuildSnapshotRoot 'scripts\verify-hotfix-dependency-transition.mjs'
  $dependencyGateReport = Invoke-NodeJsonGate `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -ScriptPath $dependencyGateScript `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -Arguments @(
      '--baseline-package', $baselinePackageJsonPath,
      '--baseline-lock', $baselinePackageLockPath,
      '--candidate-package', (Join-Path $cleanBuildSnapshotRoot 'package.json'),
      '--candidate-lock', (Join-Path $cleanBuildSnapshotRoot 'package-lock.json'),
      '--installed-node-modules', $reusedProductionNodeModulesRoot,
      '--proof-cache', $dependencyProofCachePath
    ) `
    -Label 'Reusable dependency transition gate'
  if (
    -not [bool]$dependencyGateReport.success -or
    -not [bool]$dependencyGateReport.metadataVerified -or
    -not [bool]$dependencyGateReport.physicalVerified -or
    [bool]$dependencyGateReport.requiresNodeModulesMutation -or
    @('none', 'runtime-root-declarations-only') -cnotcontains [string]$dependencyGateReport.transition -or
    [string]$dependencyGateReport.proofAlgorithm -cne 'sha256-package-lock-production-closure-v1' -or
    [int]$dependencyGateReport.packageCount -le 0 -or
    [int]$dependencyGateReport.fileCount -le 0 -or
    [int64]$dependencyGateReport.bytes -le 0 -or
    [string]$dependencyGateReport.lockPhysicalTreeFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
    [string]$dependencyGateReport.installedPhysicalTreeFingerprint -cnotmatch '^[0-9a-f]{64}$'
  ) {
    throw 'Reusable dependency transition gate did not prove a no-mutation production dependency tree.'
  }

  $buildToolchainGateReport = Assert-ReusedBuildToolchain `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -ScriptPath (Join-Path $cleanBuildSnapshotRoot 'scripts\verify-reused-build-toolchain.mjs') `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -NodeModulesRoot $reusedProductionNodeModulesRoot `
    -PackagePath (Join-Path $cleanBuildSnapshotRoot 'package.json') `
    -LockPath (Join-Path $cleanBuildSnapshotRoot 'package-lock.json')

  $productionBuildArguments = @('run', 'build:prod', '--ignore-scripts')
  Invoke-CheckedNodeCommand `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -Arguments (@($buildTools.NpmPath) + $productionBuildArguments) `
    -Label 'Production build'
  Assert-NoSourceMapsInRuntimeRoots -SnapshotRoot $cleanBuildSnapshotRoot
  if (-not (Test-Path -LiteralPath (Join-Path $cleanBuildSnapshotRoot 'dist\server\main.js') -PathType Leaf)) {
    throw 'Clean production build did not create dist\server\main.js.'
  }

  $identityWriterPath = Join-Path $cleanBuildSnapshotRoot 'scripts\write-hotfix-runtime-identity.cjs'
  Invoke-CheckedNodeCommand `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -Arguments @($identityWriterPath, '--build-root', $cleanBuildSnapshotRoot, '--deployment-id', $packageId) `
    -Label 'Runtime build identity'

  $expectedBuildFingerprint = Get-RuntimeBuildFingerprint -SnapshotRoot $cleanBuildSnapshotRoot
  $runtimeGateScript = Join-Path $cleanBuildSnapshotRoot 'scripts\verify-production-runtime-closure.mjs'
  $runtimeGateReportPath = Join-Path $cleanBuildSnapshotRoot ".hotfix-gate-$([Guid]::NewGuid().ToString('N')).report.json"
  $runtimeGateReport = Invoke-NodeJsonGate `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -ScriptPath $runtimeGateScript `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -Arguments @(
      '--server-root', (Join-Path $cleanBuildSnapshotRoot 'dist\server'),
      '--shared-root', (Join-Path $cleanBuildSnapshotRoot 'dist\shared'),
      '--package', (Join-Path $cleanBuildSnapshotRoot 'package.json'),
      '--lock', (Join-Path $cleanBuildSnapshotRoot 'package-lock.json'),
      '--node-modules-root', $reusedProductionNodeModulesRoot,
      '--expected-build-fingerprint', $expectedBuildFingerprint,
      '--verified-dependency-transition', ([string]$dependencyGateReport.transition),
      '--verified-lock-physical-tree-fingerprint', ([string]$dependencyGateReport.lockPhysicalTreeFingerprint),
      '--verified-installed-physical-tree-fingerprint', ([string]$dependencyGateReport.installedPhysicalTreeFingerprint),
      '--json-output', $runtimeGateReportPath,
      '--json'
    ) `
    -Label 'Production runtime closure gate' `
    -JsonReportPath $runtimeGateReportPath
  if (
    -not [bool]$runtimeGateReport.success -or
    [string]$runtimeGateReport.buildFingerprint -cne $expectedBuildFingerprint -or
    [string]$runtimeGateReport.dependencyMode -cne 'verified-transition' -or
    [string]$runtimeGateReport.thirdPartyAstMode -cne 'locked-physical-tree' -or
    [string]$runtimeGateReport.verifiedDependencyTransition -cne [string]$dependencyGateReport.transition -or
    [string]$runtimeGateReport.verifiedLockPhysicalTreeFingerprint -cne [string]$dependencyGateReport.lockPhysicalTreeFingerprint -or
    [string]$runtimeGateReport.verifiedInstalledPhysicalTreeFingerprint -cne [string]$dependencyGateReport.installedPhysicalTreeFingerprint -or
    [string]$runtimeGateReport.runtimeClosureFingerprint -cnotmatch '^[0-9a-f]{64}$'
  ) {
    throw 'Production runtime closure gate did not prove the frozen build.'
  }

  $clientGateScript = Join-Path $cleanBuildSnapshotRoot 'scripts\verify-client-asset-graph.mjs'
  $clientGateReport = Invoke-NodeJsonGate `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -ScriptPath $clientGateScript `
    -WorkingDirectory $cleanBuildSnapshotRoot `
    -Arguments @('--root', (Join-Path $cleanBuildSnapshotRoot 'dist\client'), '--json') `
    -Label 'Active client asset gate'
  $maxActiveClientChunkCount = 256
  $clientAssetProof = Get-ActiveClientAssetProof `
    -ClientRoot (Join-Path $cleanBuildSnapshotRoot 'dist\client') `
    -ClientReport $clientGateReport `
    -MaxActiveChunkCount $maxActiveClientChunkCount
  $activeClientAssetFingerprint = [string]$clientAssetProof.Fingerprint

  $cleanBuildSnapshotFingerprintAfter = Get-SourceSnapshotFingerprint `
    -Root $cleanBuildSnapshotRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  $sourceSnapshotFingerprintAfter = Get-SourceSnapshotFingerprint `
    -Root $selectedBuildSourceRoot `
    -DirectoryAllowlist $buildDirectoryAllowlist `
    -FileAllowlist $buildFileAllowlist
  if (
    $sourceSnapshotFingerprintBefore -cne $sourceSnapshotFingerprintAfter -or
    $copiedSourceFingerprint -cne $cleanBuildSnapshotFingerprintAfter
  ) {
    throw 'Source changed after the formal clean build was frozen.'
  }
  $workspaceDistFingerprintAfter = Get-DirectoryStateFingerprint -Path $workspaceDistPath
  if ($workspaceDistFingerprintBefore -cne $workspaceDistFingerprintAfter) {
    throw 'Workspace dist changed during isolated hotfix packaging.'
  }

  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'dist') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'release-root') -Force | Out-Null
  foreach ($runtimeRoot in $runtimeRoots) {
    $source = Join-Path $cleanBuildSnapshotRoot $runtimeRoot
    $destination = Join-Path $stageRoot $runtimeRoot
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
  }
  foreach ($entry in $releaseFileSources.GetEnumerator()) {
    if ($baselinePreservedReleaseTargets -contains [string]$entry.Key) {
      $source = Join-Path $baselineRootPath $entry.Key
    } else {
      $source = Join-Path $cleanBuildSnapshotRoot $entry.Value
    }
    $destination = Join-Path (Join-Path $stageRoot 'release-root') $entry.Key
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
  foreach ($relativePath in $supportSourceFiles) {
    $source = Join-Path $cleanBuildSnapshotRoot $relativePath
    $destination = Join-Path (Join-Path $stageRoot 'operations') $relativePath
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }

  $maxRuntimeStageBytes = 128MB
  $maxRuntimeStageFileCount = 5000
  $runtimeStageFiles = @(Get-ChildItem -LiteralPath (Join-Path $stageRoot 'dist') -File -Force -Recurse)
  $runtimeStageBytes = [int64](($runtimeStageFiles | Measure-Object -Property Length -Sum).Sum)
  if ($runtimeStageFiles.Count -gt $maxRuntimeStageFileCount -or $runtimeStageBytes -gt $maxRuntimeStageBytes) {
    throw "Runtime stage exceeds its file-count or size limit: $($runtimeStageFiles.Count) files, $runtimeStageBytes bytes."
  }

  $stageCandidatePackagePath = Join-Path $stageRoot 'release-root\package.json'
  $stageCandidatePackageLockPath = Join-Path $stageRoot 'release-root\package-lock.json'
  $candidatePackageSha256 = (Get-FileHash `
    -LiteralPath $stageCandidatePackagePath `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $candidatePackageLockSha256 = (Get-FileHash `
    -LiteralPath $stageCandidatePackageLockPath `
    -Algorithm SHA256
  ).Hash.ToLowerInvariant()

  $stageDependencyGateReport = $dependencyGateReport
  if (
    $candidatePackageSha256 -cne $frozenCandidatePackageSha256 -or
    $candidatePackageLockSha256 -cne $frozenCandidatePackageLockSha256
  ) {
    throw 'Staged dependency manifests do not match the frozen production dependency proof.'
  }
  Assert-ReusedProductionFeishuSdkPatch -NodeModulesRoot $reusedProductionNodeModulesRoot

  $stageExpectedBuildFingerprint = Get-RuntimeBuildFingerprint -SnapshotRoot $stageRoot
  if ($stageExpectedBuildFingerprint -cne $expectedBuildFingerprint) {
    throw 'Staged runtime bytes do not match the frozen production runtime proof.'
  }

  $stageClientGateReport = Invoke-NodeJsonGate `
    -BuildTools $buildTools `
    -NpmConfigPath $buildEnvironmentNpmrc `
    -ScriptPath $clientGateScript `
    -WorkingDirectory $stageRoot `
    -Arguments @('--root', (Join-Path $stageRoot 'dist\client'), '--json') `
    -Label 'Staged active client asset gate'
  $stageClientAssetProof = Get-ActiveClientAssetProof `
    -ClientRoot (Join-Path $stageRoot 'dist\client') `
    -ClientReport $stageClientGateReport `
    -MaxActiveChunkCount $maxActiveClientChunkCount
  $stageActiveClientAssetFingerprint = [string]$stageClientAssetProof.Fingerprint
  if ($stageActiveClientAssetFingerprint -cne $activeClientAssetFingerprint) {
    throw 'Staged active client asset proof does not match the frozen production client proof.'
  }

  $stageEvidenceEntries = Get-ArchiveExpectedEntries -Root $stageRoot
  Assert-ArchiveEvidenceBinding `
    -Entries $stageEvidenceEntries `
    -ExpectedBuildFingerprint $stageExpectedBuildFingerprint `
    -ClientReport $stageClientGateReport `
    -ExpectedClientFingerprint $stageActiveClientAssetFingerprint `
    -ExpectedPackageSha256 $candidatePackageSha256 `
    -ExpectedPackageLockSha256 $candidatePackageLockSha256 `
    -MaxActiveChunkCount $maxActiveClientChunkCount

$payloadFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $stageRoot 'dist') -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = Get-RelativeUnixPath -BasePath $stageRoot -FullPath $_.FullName
      Assert-SafePackagePath -RelativePath $relativePath
      [ordered]@{
        path = $relativePath
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size = $_.Length
      }
    }
)
if ($payloadFiles.Count -lt 3) {
  throw 'The complete runtime payload is unexpectedly empty.'
}

$releaseFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $stageRoot 'release-root') -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = Get-RelativeUnixPath -BasePath $stageRoot -FullPath $_.FullName
      Assert-SafePackagePath -RelativePath $relativePath
      $targetPath = $relativePath.Substring('release-root/'.Length)
      $baselineTargetPath = Join-Path $baselineRootPath $targetPath
      if ((Test-Path -LiteralPath $baselineTargetPath) -and -not (Test-Path -LiteralPath $baselineTargetPath -PathType Leaf)) {
        throw "Server baseline release target is not a file: $targetPath"
      }
      $baselineExisted = Test-Path -LiteralPath $baselineTargetPath -PathType Leaf
      [ordered]@{
        path = $relativePath
        targetPath = $targetPath
        baselineExisted = $baselineExisted
        baselineSha256 = if ($baselineExisted) {
          (Get-FileHash -LiteralPath $baselineTargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else {
          $null
        }
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size = $_.Length
      }
    }
)
if ($releaseFiles.Count -ne $releaseFileSources.Count) {
  throw 'The release-root file set is incomplete.'
}

$supportFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $stageRoot 'operations') -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
      $relativePath = Get-RelativeUnixPath -BasePath $stageRoot -FullPath $_.FullName
      Assert-SafePackagePath -RelativePath $relativePath
      [ordered]@{
        path = $relativePath
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size = $_.Length
      }
    }
)
if ($supportFiles.Count -ne $supportSourceFiles.Count) {
  throw 'The release support file set is incomplete.'
}
$supportFileByPath = @{}
foreach ($supportEntry in $supportFiles) {
  $supportFileByPath[[string]$supportEntry.path] = $supportEntry
}
$recoveryLauncherSupportPath = 'operations/deploy/hotfix-recovery-start.ps1'
$dependencyVerifierSupportPath = 'operations/scripts/verify-hotfix-dependency-transition.mjs'
$clientVerifierSupportPath = 'operations/scripts/verify-client-asset-graph.mjs'
foreach ($requiredSupportPath in @(
  $recoveryLauncherSupportPath,
  $dependencyVerifierSupportPath,
  $clientVerifierSupportPath
)) {
  if (-not $supportFileByPath.ContainsKey($requiredSupportPath)) {
    throw "Required release proof support file is missing: $requiredSupportPath"
  }
}

$baseEntries = @(
  foreach ($relativePath in @($baseFileSources.Keys)) {
    $sourcePath = Join-Path $cleanBuildSnapshotRoot $baseFileSources[$relativePath]
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Required release source file is missing: $($baseFileSources[$relativePath])"
    }
    $fullPath = Join-Path $baselineRootPath $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Required server baseline file is missing: $relativePath"
    }
    [ordered]@{
      path = $relativePath.Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath (Join-Path $baselineRootPath $relativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
)
$baseFingerprintMaterial = ($baseEntries | ForEach-Object { "$($_.path):$($_.sha256)" }) -join "`n"
$baseFingerprint = Get-TextSha256 -Text $baseFingerprintMaterial

$manifest = [ordered]@{
  schemaVersion = 6
  packageId = $packageId
  createdAt = (Get-Date).ToString('o')
  releaseMode = 'complete-runtime-atomic-switch'
  releaseToolFingerprint = $releaseToolFingerprintAtStart
  installedReleaseReceiptSchemaVersion = 2
  recoveryLauncherSha256 = [string]$supportFileByPath[$recoveryLauncherSupportPath].sha256
  dependencyVerifierSha256 = [string]$supportFileByPath[$dependencyVerifierSupportPath].sha256
  clientVerifierSha256 = [string]$supportFileByPath[$clientVerifierSupportPath].sha256
  buildNodeVersion = [string]$buildTools.NodeVersion
  buildNpmVersion = [string]$buildTools.NpmVersion
  buildNodeSha256 = [string]$buildTools.NodeSha256
  buildNpmSha256 = [string]$buildTools.NpmSha256
  candidatePackageSha256 = $candidatePackageSha256
  candidatePackageLockSha256 = $candidatePackageLockSha256
  sourceSnapshotFingerprint = $sourceSnapshotFingerprintBefore
  buildFingerprint = $stageExpectedBuildFingerprint
  runtimeClosureFingerprint = [string]$runtimeGateReport.runtimeClosureFingerprint
  runtimeClosureMode = [string]$runtimeGateReport.dependencyMode
  dependencyRuntimeAuditMode = [string]$runtimeGateReport.thirdPartyAstMode
  dependencyTreeMode = 'verified-existing-production-tree'
  activeClientAssetFingerprint = $stageActiveClientAssetFingerprint
  activeClientProofAlgorithm = 'sha256-active-client-closure-v2'
  activeClientChunkCount = [int]$stageClientAssetProof.ActiveChunkCount
  activeClientAssetCount = [int]$stageClientAssetProof.AssetCount
  activeClientFiles = @($stageClientAssetProof.Entries)
  dependencyLockPhysicalTreeFingerprint = [string]$stageDependencyGateReport.lockPhysicalTreeFingerprint
  dependencyInstalledPhysicalTreeFingerprint = [string]$stageDependencyGateReport.installedPhysicalTreeFingerprint
  dependencyProofAlgorithm = [string]$stageDependencyGateReport.proofAlgorithm
  dependencyPackageCount = [int]$stageDependencyGateReport.packageCount
  dependencyFileCount = [int]$stageDependencyGateReport.fileCount
  dependencyBytes = [int64]$stageDependencyGateReport.bytes
  dependencyTransition = [string]$stageDependencyGateReport.transition
  baseFingerprint = $baseFingerprint
  baselineFingerprint = [string]$baselineExportManifest.baselineFingerprint
  baselineExportSchemaVersion = [int]$baselineExportManifest.schemaVersion
  baselineExportType = [string]$baselineExportManifest.exportType
  baselineExportPlanAlgorithm = [string]$baselineExportManifest.exportPlanAlgorithm
  baselineExportPlanFingerprint = [string]$baselineExportManifest.exportPlanFingerprint
  baselineFileCount = [int]$baselineExportManifest.baselineFileCount
  baselinePayloadFileCount = [int]$baselineExportManifest.fileCount
  baselineMetadataOnlyFileCount = [int]$baselineExportManifest.nonExportedRuntimeFileCount
  baselineUncompressedBytes = [int64]$baselineExportManifest.uncompressedBytes
  baseFiles = $baseEntries
  distFingerprints = $baselineExportManifest.distFingerprints
  serverBaselineFiles = @($baselineExport.VerifiedFiles)
  runtimeRoots = @('dist/server', 'dist/shared', 'dist/client')
  payloadFiles = $payloadFiles
  releaseFiles = $releaseFiles
  supportFiles = $supportFiles
  controlFiles = @()
  forbiddenPaths = @('.env', '.runtime', 'nantong-schedule-state', 'logs', 'node_modules', 'certs')
  healthEndpoint = 'https://127.0.0.1:3001/api/access/session'
}

$installer = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [int]$HealthTimeoutSeconds = 600,
  [string]$HealthEndpoint = 'https://127.0.0.1:3001/api/access/session',
  [switch]$ValidateServerBaselineOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('NantongHotfixNativeMethods' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class NantongHotfixNativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("shell32.dll", SetLastError = true)]
  public static extern IntPtr CommandLineToArgvW(
    [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
    out int argumentCount
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(
    SafeFileHandle fileHandle,
    StringBuilder filePath,
    uint filePathLength,
    uint flags
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle fileHandle,
    out FileInformation fileInformation
  );

  public static string GetFinalPath(string path) {
    const uint FILE_READ_ATTRIBUTES = 0x80;
    const uint FILE_SHARE_READ = 0x1;
    const uint FILE_SHARE_WRITE = 0x2;
    const uint FILE_SHARE_DELETE = 0x4;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    using (SafeFileHandle handle = CreateFile(
      path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero
    )) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      StringBuilder buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return buffer.ToString();
    }
  }

  public static void AssertDirectoryRenameAccess(string path) {
    const uint DELETE = 0x10000;
    const uint FILE_READ_ATTRIBUTES = 0x80;
    const uint FILE_SHARE_ALL = 0x7;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    using (SafeFileHandle handle = CreateFile(
      path,
      DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_ALL,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero
    )) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    }
  }

  public static string GetFileIdentity(string path) {
    const uint FILE_READ_ATTRIBUTES = 0x80;
    const uint FILE_SHARE_READ = 0x1;
    const uint FILE_SHARE_WRITE = 0x2;
    const uint FILE_SHARE_DELETE = 0x4;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    using (SafeFileHandle handle = CreateFile(
      path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero
    )) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return String.Format(
        "{0:x8}:{1:x8}:{2:x8}",
        information.VolumeSerialNumber,
        information.FileIndexHigh,
        information.FileIndexLow
      );
    }
  }
}
"@
}

$MOVEFILE_REPLACE_EXISTING = 0x1
$MOVEFILE_WRITE_THROUGH = 0x8
$script:installedDependencyProofCache = @{}

function Get-HotfixTransactionPayload {
  param([object]$Transaction)
  return [ordered]@{
    schemaVersion = [int]$Transaction.schemaVersion
    transactionId = [string]$Transaction.transactionId
    deploymentId = [string]$Transaction.deploymentId
    appRoot = [string]$Transaction.appRoot
    intent = [string]$Transaction.intent
    phase = [string]$Transaction.phase
    releaseFiles = @(
      foreach ($entry in @($Transaction.releaseFiles)) {
        [ordered]@{
          targetPath = [string]$entry.targetPath
          baselineExisted = [bool]$entry.baselineExisted
          baselineSha256 = [string]$entry.baselineSha256
          candidateSha256 = [string]$entry.candidateSha256
        }
      }
    )
  }
}

function Get-HotfixTransactionChecksum {
  param([object]$Transaction)
  return Get-TextSha256 -Text ((Get-HotfixTransactionPayload -Transaction $Transaction) |
    ConvertTo-Json -Compress -Depth 8)
}

function Get-DurableAtomicFileState {
  param([string]$Path)
  Assert-PathHasNoReparsePointAncestors -Path $Path
  Assert-FinalPathContainedByRoot -Root (Split-Path -Parent $Path) -Path $Path
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ exists = $false; identity = ''; sha256 = '' }
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'An atomic metadata destination is not a regular file.'
  }
  Assert-NoAlternateDataStreamsAtPath -Path $Path
  $identity = [NantongHotfixNativeMethods]::GetFileIdentity($Path)
  $sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([NantongHotfixNativeMethods]::GetFileIdentity($Path) -cne $identity) {
    throw 'An atomic metadata file changed while capturing its identity.'
  }
  return [pscustomobject]@{ exists = $true; identity = $identity; sha256 = $sha256 }
}

function Move-DurableAtomicFileWithRetry {
  param([string]$Source, [string]$Destination, [string]$Label)
  if (-not [string]::Equals(
    [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Source)),
    [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Destination)),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Atomic metadata replacement requires the same directory.'
  }
  $sourceState = Get-DurableAtomicFileState -Path $Source
  $destinationState = Get-DurableAtomicFileState -Path $Destination
  if (-not $sourceState.exists) { throw 'The durable metadata temporary file is missing.' }
  $moveFlags = $MOVEFILE_REPLACE_EXISTING -bor $MOVEFILE_WRITE_THROUGH
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($attempt = 1; $attempt -le 11; $attempt++) {
    if ($attempt -gt 1) {
      foreach ($pair in @(
        @{ path = $Source; state = $sourceState },
        @{ path = $Destination; state = $destinationState }
      )) {
        $current = Get-DurableAtomicFileState -Path $pair.path
        if (
          $current.exists -ne $pair.state.exists -or
          $current.identity -cne $pair.state.identity -or
          $current.sha256 -cne $pair.state.sha256
        ) {
          throw 'An atomic metadata file changed during retry; refusing to overwrite another writer.'
        }
      }
    }
    if ([NantongHotfixNativeMethods]::MoveFileEx($Source, $Destination, $moveFlags)) {
      if ($attempt -gt 1) {
        Write-Host "[INFO] Atomic $Label replacement recovered after $attempt attempts ($($clock.ElapsedMilliseconds) ms)."
      }
      return
    }
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if (@(5, 32, 33) -notcontains $errorCode -or $attempt -eq 11) {
      throw "The $Label could not be atomically replaced. Win32=$errorCode; attempts=$attempt; elapsedMs=$($clock.ElapsedMilliseconds). The prior file was not deleted or modified."
    }
    if ($attempt -eq 1) {
      Write-Host "[INFO] Atomic $Label replacement was denied (Win32=$errorCode); retrying with at most 10 bounded 200 ms waits without deleting the prior file."
    }
    Start-Sleep -Milliseconds 200
  }
}

function Write-DurableHotfixTransaction {
  param([string]$Path, [object]$Transaction)
  $payload = Get-HotfixTransactionPayload -Transaction $Transaction
  $payload['transactionChecksum'] = Get-HotfixTransactionChecksum -Transaction $payload
  $json = $payload | ConvertTo-Json -Compress -Depth 8
  $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $journalStream = [System.IO.File]::Open(
    $temporaryPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $journalStream.Write($bytes, 0, $bytes.Length)
    $journalStream.Flush($true)
  } finally {
    $journalStream.Dispose()
  }
  try {
    Move-DurableAtomicFileWithRetry -Source $temporaryPath -Destination $Path -Label 'durable hotfix transaction journal'
  } catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw
  }
  return [pscustomobject]$payload
}

function Read-StrictHotfixTransaction {
  param([string]$Path, [string]$ExpectedAppRoot)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    $transaction = ([System.IO.File]::ReadAllText(
      $Path,
      [System.Text.UTF8Encoding]::new($false)
    )) |
      ConvertFrom-Json -ErrorAction Stop
    Assert-ExactObjectProperties `
      -Object $transaction `
      -ExpectedNames @(
        'schemaVersion', 'transactionId', 'deploymentId', 'appRoot',
        'intent', 'phase', 'releaseFiles', 'transactionChecksum'
      ) `
      -Context 'The hotfix transaction journal'
    $allowedPhases = @(
      'stage-intent', 'prepared', 'runtime-stopped', 'dist-backup-intent', 'dist-backed-up',
      'candidate-dist-intent', 'candidate-dist-installed',
      'release-files-installed', 'candidate-started', 'candidate-healthy',
      'committed', 'finalized', 'rolled-back'
    )
    $transactionGuid = [Guid]::Empty
    if (
      [int]$transaction.schemaVersion -ne 1 -or
      -not [Guid]::TryParse([string]$transaction.transactionId, [ref]$transactionGuid) -or
      [string]::IsNullOrWhiteSpace([string]$transaction.deploymentId) -or
      [string]$transaction.intent -cne 'deploy' -or
      $allowedPhases -cnotcontains [string]$transaction.phase -or
      -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$transaction.appRoot).TrimEnd('\'),
        [System.IO.Path]::GetFullPath($ExpectedAppRoot).TrimEnd('\'),
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      [string]$transaction.transactionChecksum -cnotmatch '^[0-9a-f]{64}$'
    ) {
      throw 'strict schema values are invalid'
    }
    foreach ($entry in @($transaction.releaseFiles)) {
      Assert-ExactObjectProperties `
        -Object $entry `
        -ExpectedNames @('targetPath', 'baselineExisted', 'baselineSha256', 'candidateSha256') `
        -Context 'A hotfix transaction release-file entry'
      [void](Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath))
      if (
        [string]$entry.candidateSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        ([bool]$entry.baselineExisted -and [string]$entry.baselineSha256 -cnotmatch '^[0-9a-f]{64}$') -or
        (-not [bool]$entry.baselineExisted -and -not [string]::IsNullOrEmpty([string]$entry.baselineSha256))
      ) {
        throw 'release-file hash values are invalid'
      }
    }
    if ((Get-HotfixTransactionChecksum -Transaction $transaction) -cne [string]$transaction.transactionChecksum) {
      throw 'transaction checksum mismatch'
    }
    return $transaction
  } catch {
    throw "The hotfix transaction journal failed strict schema or checksum validation: $($_.Exception.Message)"
  }
}

function Get-InstalledReleaseReceiptPayload {
  param([object]$Receipt)
  $payload = [ordered]@{
    schemaVersion = [int]$Receipt.schemaVersion
    receiptType = [string]$Receipt.receiptType
    deploymentId = [string]$Receipt.deploymentId
    appRoot = [string]$Receipt.appRoot
    releaseToolFingerprint = [string]$Receipt.releaseToolFingerprint
  }
  if ([int]$Receipt.schemaVersion -eq 1) {
    $payload['dependencyLockPhysicalTreeFingerprint'] = [string]$Receipt.dependencyLockPhysicalTreeFingerprint
    $payload['dependencyInstalledPhysicalTreeFingerprint'] = [string]$Receipt.dependencyInstalledPhysicalTreeFingerprint
    $payload['buildFingerprint'] = [string]$Receipt.buildFingerprint
    $payload['runtimeClosureFingerprint'] = [string]$Receipt.runtimeClosureFingerprint
    $payload['activeClientAssetFingerprint'] = [string]$Receipt.activeClientAssetFingerprint
    $payload['runtimeFiles'] = @(
      foreach ($entry in @($Receipt.runtimeFiles)) {
        [ordered]@{
          path = [string]$entry.path
          size = [int64]$entry.size
          sha256 = [string]$entry.sha256
        }
      }
    )
    $payload['clientEntryFiles'] = @(
      foreach ($entry in @($Receipt.clientEntryFiles)) {
        [ordered]@{
          path = [string]$entry.path
          size = [int64]$entry.size
          sha256 = [string]$entry.sha256
        }
      }
    )
  } else {
    $payload['installerSha256'] = [string]$Receipt.installerSha256
    $payload['recoveryLauncherSha256'] = [string]$Receipt.recoveryLauncherSha256
    $payload['dependencyVerifierSha256'] = [string]$Receipt.dependencyVerifierSha256
    $payload['clientVerifierSha256'] = [string]$Receipt.clientVerifierSha256
    $payload['dependencyProofAlgorithm'] = [string]$Receipt.dependencyProofAlgorithm
    $payload['dependencyLockPhysicalTreeFingerprint'] = [string]$Receipt.dependencyLockPhysicalTreeFingerprint
    $payload['dependencyInstalledPhysicalTreeFingerprint'] = [string]$Receipt.dependencyInstalledPhysicalTreeFingerprint
    $payload['dependencyPackageCount'] = [int]$Receipt.dependencyPackageCount
    $payload['dependencyFileCount'] = [int]$Receipt.dependencyFileCount
    $payload['dependencyBytes'] = [int64]$Receipt.dependencyBytes
    $payload['buildFingerprint'] = [string]$Receipt.buildFingerprint
    $payload['runtimeClosureFingerprint'] = [string]$Receipt.runtimeClosureFingerprint
    $payload['activeClientProofAlgorithm'] = [string]$Receipt.activeClientProofAlgorithm
    $payload['activeClientAssetFingerprint'] = [string]$Receipt.activeClientAssetFingerprint
    $payload['activeClientChunkCount'] = [int]$Receipt.activeClientChunkCount
    $payload['activeClientAssetCount'] = [int]$Receipt.activeClientAssetCount
    $payload['runtimeFiles'] = @(
      foreach ($entry in @($Receipt.runtimeFiles)) {
        [ordered]@{
          path = [string]$entry.path
          size = [int64]$entry.size
          sha256 = [string]$entry.sha256
        }
      }
    )
    $payload['activeClientFiles'] = @(
      foreach ($entry in @($Receipt.activeClientFiles)) {
        [ordered]@{
          path = [string]$entry.path
          size = [int64]$entry.size
          sha256 = [string]$entry.sha256
        }
      }
    )
  }
  $payload['releaseFiles'] = @(
    foreach ($entry in @($Receipt.releaseFiles)) {
      [ordered]@{
        targetPath = [string]$entry.targetPath
        size = [int64]$entry.size
        sha256 = [string]$entry.sha256
      }
    }
  )
  return $payload
}

function Get-InstalledReleaseReceiptChecksum {
  param([object]$Receipt)
  return Get-TextSha256 -Text ((Get-InstalledReleaseReceiptPayload -Receipt $Receipt) |
    ConvertTo-Json -Compress -Depth 10)
}

function New-InstalledReleaseReceipt {
  param(
    [string]$Root,
    [object]$Manifest,
    [object]$DependencyProofReport
  )
  $runtimeFiles = @(
    @($Manifest.payloadFiles) |
      Where-Object {
        ([string]$_.path).StartsWith('dist/server/', [System.StringComparison]::Ordinal) -or
        ([string]$_.path).StartsWith('dist/shared/', [System.StringComparison]::Ordinal)
      } |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object {
        [ordered]@{
          path = [string]$_.path
          size = [int64]$_.size
          sha256 = [string]$_.sha256
        }
      }
  )
  $activeClientFiles = @(
    @((Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientFiles')) |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object {
        $relativePath = [string]$_.path
        $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $relativePath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
          throw "The committed active client file is missing: $relativePath"
        }
        Assert-PathHasNoReparsePointAncestors -Path $fullPath
        Assert-FinalPathContainedByRoot -Root $Root -Path $fullPath
        Assert-NoAlternateDataStreamsAtPath -Path $fullPath
        $actualSize = (Get-Item -LiteralPath $fullPath -Force).Length
        $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSize -ne [int64]$_.size -or $actualHash -cne [string]$_.sha256) {
          throw "The committed active client file does not match its manifest: $relativePath"
        }
        [ordered]@{
          path = $relativePath
          size = [int64]$actualSize
          sha256 = $actualHash
        }
      }
  )
  if ($runtimeFiles.Count -eq 0 -or $activeClientFiles.Count -eq 0) {
    throw 'The committed candidate cannot produce a complete installed-release receipt.'
  }
  $receipt = [pscustomobject][ordered]@{
    schemaVersion = 2
    receiptType = 'nantong-hotfix-installed-release'
    deploymentId = [string]$Manifest.packageId
    appRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    releaseToolFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'releaseToolFingerprint')
    installerSha256 = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'installerSha256')
    recoveryLauncherSha256 = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'recoveryLauncherSha256')
    dependencyVerifierSha256 = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyVerifierSha256')
    clientVerifierSha256 = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'clientVerifierSha256')
    dependencyProofAlgorithm = [string](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'proofAlgorithm')
    dependencyLockPhysicalTreeFingerprint = [string](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'lockPhysicalTreeFingerprint')
    dependencyInstalledPhysicalTreeFingerprint = [string](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'installedPhysicalTreeFingerprint')
    dependencyPackageCount = [int](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'packageCount')
    dependencyFileCount = [int](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'fileCount')
    dependencyBytes = [int64](Get-RequiredObjectPropertyValue -Object $DependencyProofReport -Name 'bytes')
    buildFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'buildFingerprint')
    runtimeClosureFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'runtimeClosureFingerprint')
    activeClientProofAlgorithm = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientProofAlgorithm')
    activeClientAssetFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientAssetFingerprint')
    activeClientChunkCount = [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientChunkCount')
    activeClientAssetCount = [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientAssetCount')
    runtimeFiles = $runtimeFiles
    activeClientFiles = $activeClientFiles
    releaseFiles = @(
      @($Manifest.releaseFiles) |
        Sort-Object { Get-PathSortKey -Path ([string]$_.targetPath) } |
        ForEach-Object {
          [ordered]@{
            targetPath = [string]$_.targetPath
            size = [int64]$_.size
            sha256 = [string]$_.sha256
          }
        }
    )
    receiptChecksum = ''
  }
  $receipt.receiptChecksum = Get-InstalledReleaseReceiptChecksum -Receipt $receipt
  return $receipt
}

function Write-DurableInstalledReleaseReceipt {
  param(
    [string]$Path,
    [object]$Receipt
  )
  $root = [System.IO.Path]::GetFullPath([string]$Receipt.appRoot).TrimEnd('\')
  Assert-PathHasNoReparsePointAncestors -Path $Path
  Assert-FinalPathContainedByRoot -Root $root -Path $Path
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'The installed-release receipt path is not a regular file.'
  }
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Assert-NoAlternateDataStreamsAtPath -Path $Path
  }
  $payload = Get-InstalledReleaseReceiptPayload -Receipt $Receipt
  $payload['receiptChecksum'] = Get-InstalledReleaseReceiptChecksum -Receipt $payload
  $json = $payload | ConvertTo-Json -Compress -Depth 10
  $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $receiptStream = [System.IO.File]::Open(
    $temporaryPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $receiptStream.Write($bytes, 0, $bytes.Length)
    $receiptStream.Flush($true)
  } finally {
    $receiptStream.Dispose()
  }
  try {
    Move-DurableAtomicFileWithRetry -Source $temporaryPath -Destination $Path -Label 'installed-release receipt'
  } catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw
  }
  return [pscustomobject]$payload
}

function Read-StrictInstalledReleaseReceipt {
  param(
    [string]$Path,
    [string]$ExpectedAppRoot
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'The installed-release receipt path is not a regular file.'
  }
  try {
    Assert-PathHasNoReparsePointAncestors -Path $Path
    Assert-FinalPathContainedByRoot -Root $ExpectedAppRoot -Path $Path
    Assert-NoAlternateDataStreamsAtPath -Path $Path
    $receipt = ([System.IO.File]::ReadAllText(
      $Path,
      [System.Text.UTF8Encoding]::new($false)
    )) | ConvertFrom-Json -ErrorAction Stop
    $schemaVersion = [int]$receipt.schemaVersion
    $expectedReceiptNames = if ($schemaVersion -eq 1) {
      @(
        'schemaVersion', 'receiptType', 'deploymentId', 'appRoot',
        'releaseToolFingerprint', 'dependencyLockPhysicalTreeFingerprint',
        'dependencyInstalledPhysicalTreeFingerprint', 'buildFingerprint',
        'runtimeClosureFingerprint', 'activeClientAssetFingerprint',
        'runtimeFiles', 'clientEntryFiles', 'releaseFiles', 'receiptChecksum'
      )
    } elseif ($schemaVersion -eq 2) {
      @(
        'schemaVersion', 'receiptType', 'deploymentId', 'appRoot',
        'releaseToolFingerprint', 'installerSha256', 'recoveryLauncherSha256',
        'dependencyVerifierSha256', 'clientVerifierSha256',
        'dependencyProofAlgorithm', 'dependencyLockPhysicalTreeFingerprint',
        'dependencyInstalledPhysicalTreeFingerprint', 'dependencyPackageCount',
        'dependencyFileCount', 'dependencyBytes', 'buildFingerprint',
        'runtimeClosureFingerprint', 'activeClientProofAlgorithm',
        'activeClientAssetFingerprint', 'activeClientChunkCount',
        'activeClientAssetCount', 'runtimeFiles', 'activeClientFiles',
        'releaseFiles', 'receiptChecksum'
      )
    } else {
      throw 'unsupported installed-release receipt schema'
    }
    Assert-ExactObjectProperties `
      -Object $receipt `
      -ExpectedNames $expectedReceiptNames `
      -Context 'The installed-release receipt'
    if (
      [string]$receipt.receiptType -cne 'nantong-hotfix-installed-release' -or
      [string]$receipt.deploymentId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$' -or
      -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$receipt.appRoot).TrimEnd('\'),
        [System.IO.Path]::GetFullPath($ExpectedAppRoot).TrimEnd('\'),
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      [string]$receipt.releaseToolFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.dependencyLockPhysicalTreeFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.dependencyInstalledPhysicalTreeFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.buildFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.runtimeClosureFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.activeClientAssetFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$receipt.receiptChecksum -cnotmatch '^[0-9a-f]{64}$'
    ) {
      throw 'strict schema values are invalid'
    }
    if ($schemaVersion -eq 2) {
      if (
        [string]$receipt.installerSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$receipt.recoveryLauncherSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$receipt.dependencyVerifierSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$receipt.clientVerifierSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]$receipt.dependencyProofAlgorithm -cne 'sha256-package-lock-production-closure-v1' -or
        [string]$receipt.activeClientProofAlgorithm -cne 'sha256-active-client-closure-v2' -or
        [int]$receipt.activeClientChunkCount -le 0 -or
        [int]$receipt.activeClientAssetCount -le 0 -or
        [int]$receipt.dependencyPackageCount -le 0 -or
        [int]$receipt.dependencyFileCount -le 0 -or
        [int64]$receipt.dependencyBytes -le 0
      ) {
        throw 'strict version-2 proof values are invalid'
      }
    }
    $runtimePaths = @{}
    foreach ($entry in @($receipt.runtimeFiles)) {
      Assert-ExactObjectProperties -Object $entry -ExpectedNames @('path', 'size', 'sha256') -Context 'An installed-release runtime entry'
      $relativePath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.path)
      if (
        -not $relativePath.StartsWith('dist/server/', [System.StringComparison]::Ordinal) -and
        -not $relativePath.StartsWith('dist/shared/', [System.StringComparison]::Ordinal)
      ) {
        throw "installed-release runtime path is outside strict roots: $relativePath"
      }
      if ($runtimePaths.ContainsKey($relativePath)) {
        throw "duplicate installed-release runtime path: $relativePath"
      }
      $runtimePaths[$relativePath] = $true
      [void](Get-NonNegativeInt64ManifestValue -Value $entry.size -Name "installed-release.size:$relativePath")
      if ([string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "invalid installed-release runtime hash: $relativePath"
      }
    }
    if ($runtimePaths.Count -eq 0) {
      throw 'installed-release runtime entries are empty'
    }
    $clientPaths = @{}
    $clientEntries = if ($schemaVersion -eq 1) { @($receipt.clientEntryFiles) } else { @($receipt.activeClientFiles) }
    $clientDescriptors = @(
      foreach ($entry in $clientEntries) {
        Assert-ExactObjectProperties -Object $entry -ExpectedNames @('path', 'size', 'sha256') -Context 'An installed-release client entry'
        $relativePath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.path)
        if ($schemaVersion -eq 1) {
          if (@('dist/client/index.html', 'dist/client/main.js') -cnotcontains $relativePath) {
            throw "installed-release client entry is not a recognized entry file: $relativePath"
          }
        } elseif (-not $relativePath.StartsWith('dist/client/', [System.StringComparison]::Ordinal)) {
          throw "installed-release active client path is outside dist/client: $relativePath"
        }
        if ($clientPaths.ContainsKey($relativePath)) {
          throw "duplicate installed-release client entry: $relativePath"
        }
        $clientPaths[$relativePath] = $true
        $size = Get-NonNegativeInt64ManifestValue -Value $entry.size -Name "installed-release.size:$relativePath"
        if ([string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
          throw "invalid installed-release client hash: $relativePath"
        }
        if ($schemaVersion -eq 2) {
          $assetPath = $relativePath.Substring('dist/client/'.Length)
          "asset`0$assetPath`0$size`0$([string]$entry.sha256)"
        }
      }
    )
    if ($clientPaths.Count -eq 0 -or ($schemaVersion -eq 2 -and $clientPaths.Count -gt 2048)) {
      throw 'installed-release client entry count is outside the allowed range'
    }
    if ($schemaVersion -eq 2) {
      if (
        $clientPaths.Count -ne [int]$receipt.activeClientAssetCount -or
        [int]$receipt.activeClientChunkCount -gt [int]$receipt.activeClientAssetCount
      ) {
        throw 'installed-release active client counts do not match its entries'
      }
      foreach ($requiredClientPath in @(
        'dist/client/index.html',
        'dist/client/main.js',
        'dist/client/main.css'
      )) {
        if (-not $clientPaths.ContainsKey($requiredClientPath)) {
          throw "installed-release active client proof is missing: $requiredClientPath"
        }
      }
      $clientProofMaterial = @(
        $clientDescriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }
      ) -join "`n"
      if ((Get-TextSha256 -Text $clientProofMaterial) -cne [string]$receipt.activeClientAssetFingerprint) {
        throw 'installed-release active client fingerprint does not match its entries'
      }
    }
    $releasePaths = @{}
    foreach ($entry in @($receipt.releaseFiles)) {
      Assert-ExactObjectProperties -Object $entry -ExpectedNames @('targetPath', 'size', 'sha256') -Context 'An installed-release root entry'
      $relativePath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
      if ($releasePaths.ContainsKey($relativePath)) {
        throw "duplicate installed-release root path: $relativePath"
      }
      $releasePaths[$relativePath] = $true
      [void](Get-NonNegativeInt64ManifestValue -Value $entry.size -Name "installed-release.size:$relativePath")
      if ([string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "invalid installed-release root hash: $relativePath"
      }
    }
    if ((Get-InstalledReleaseReceiptChecksum -Receipt $receipt) -cne [string]$receipt.receiptChecksum) {
      throw 'receipt checksum mismatch'
    }
    return $receipt
  } catch {
    throw "The installed-release receipt failed strict schema or checksum validation: $($_.Exception.Message)"
  }
}

function Test-InstalledReleaseReceiptCompatibility {
  param(
    [object]$Receipt,
    [object]$Manifest
  )
  return (
    [int]$Receipt.schemaVersion -eq 2 -and
    [string]$Receipt.releaseToolFingerprint -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'releaseToolFingerprint') -and
    [string]$Receipt.installerSha256 -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'installerSha256') -and
    [string]$Receipt.recoveryLauncherSha256 -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'recoveryLauncherSha256') -and
    [string]$Receipt.dependencyVerifierSha256 -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyVerifierSha256') -and
    [string]$Receipt.clientVerifierSha256 -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'clientVerifierSha256') -and
    [string]$Receipt.dependencyProofAlgorithm -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyProofAlgorithm') -and
    [string]$Receipt.dependencyLockPhysicalTreeFingerprint -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyLockPhysicalTreeFingerprint') -and
    [string]$Receipt.dependencyInstalledPhysicalTreeFingerprint -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyInstalledPhysicalTreeFingerprint') -and
    [int]$Receipt.dependencyPackageCount -eq [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyPackageCount') -and
    [int]$Receipt.dependencyFileCount -eq [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyFileCount') -and
    [int64]$Receipt.dependencyBytes -eq [int64](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyBytes') -and
    [string]$Receipt.activeClientProofAlgorithm -ceq [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientProofAlgorithm')
  )
}

function Get-InstalledReceiptReleaseBaselineOverrides {
  param(
    [object]$Receipt,
    [object]$Manifest
  )
  $currentTargets = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $currentTargets[(Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath))] = $true
  }
  return @(
    foreach ($entry in @($Receipt.releaseFiles)) {
      $targetPath = [string]$entry.targetPath
      if ($currentTargets.ContainsKey($targetPath)) {
        [pscustomobject][ordered]@{
          targetPath = $targetPath
          baselineExisted = $true
          baselineSha256 = [string]$entry.sha256
        }
      }
    }
  )
}

function Get-ReleaseBaselineOverrideMap {
  param([object[]]$ReleaseBaselineOverrides)
  $result = @{}
  foreach ($entry in @($ReleaseBaselineOverrides)) {
    $targetPath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
    if ($result.ContainsKey($targetPath)) {
      throw "A release baseline snapshot contains a duplicate target: $targetPath"
    }
    if (
      ([bool]$entry.baselineExisted -and [string]$entry.baselineSha256 -cnotmatch '^[0-9a-f]{64}$') -or
      (-not [bool]$entry.baselineExisted -and -not [string]::IsNullOrEmpty([string]$entry.baselineSha256))
    ) {
      throw "A release baseline snapshot contains an invalid hash: $targetPath"
    }
    $result[$targetPath] = [pscustomobject][ordered]@{
      targetPath = $targetPath
      baselineExisted = [bool]$entry.baselineExisted
      baselineSha256 = [string]$entry.baselineSha256
    }
  }
  return $result
}

function Get-TransactionReleaseBaselineOverrides {
  param([object]$Transaction)
  return @(
    foreach ($entry in @($Transaction.releaseFiles)) {
      [pscustomobject][ordered]@{
        targetPath = [string]$entry.targetPath
        baselineExisted = [bool]$entry.baselineExisted
        baselineSha256 = [string]$entry.baselineSha256
      }
    }
  )
}

function New-HotfixTransaction {
  param(
    [string]$DeploymentId,
    [string]$AppRoot,
    [object]$Manifest,
    [object[]]$ReleaseBaselineOverrides = @()
  )
  $releaseBaselineOverrideMap = Get-ReleaseBaselineOverrideMap `
    -ReleaseBaselineOverrides $ReleaseBaselineOverrides
  $managedReleaseTargets = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $managedReleaseTargets[(Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath))] = $true
  }
  foreach ($overrideTarget in @($releaseBaselineOverrideMap.Keys)) {
    if (-not $managedReleaseTargets.ContainsKey([string]$overrideTarget)) {
      throw "A release baseline snapshot contains an unmanaged target: $overrideTarget"
    }
  }
  if (
    $releaseBaselineOverrideMap.Count -gt 0 -and
    $releaseBaselineOverrideMap.Count -ne @($Manifest.releaseFiles).Count
  ) {
    throw 'A release baseline snapshot must cover every managed release target.'
  }
  return [pscustomobject][ordered]@{
    schemaVersion = 1
    transactionId = [Guid]::NewGuid().ToString('D')
    deploymentId = $DeploymentId
    appRoot = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
    intent = 'deploy'
    phase = 'stage-intent'
    releaseFiles = @(
      foreach ($entry in @($Manifest.releaseFiles)) {
        $targetPath = [string]$entry.targetPath
        $baseline = if ($releaseBaselineOverrideMap.ContainsKey($targetPath)) {
          $releaseBaselineOverrideMap[$targetPath]
        } else {
          $entry
        }
        [ordered]@{
          targetPath = $targetPath
          baselineExisted = [bool]$baseline.baselineExisted
          baselineSha256 = if ([bool]$baseline.baselineExisted) { [string]$baseline.baselineSha256 } else { '' }
          candidateSha256 = [string]$entry.sha256
        }
      }
    )
    transactionChecksum = ''
  }
}

function Set-HotfixTransactionPhase {
  param([string]$Path, [object]$Transaction, [string]$Phase)
  $payload = Get-HotfixTransactionPayload -Transaction $Transaction
  $payload['phase'] = $Phase
  return Write-DurableHotfixTransaction -Path $Path -Transaction $payload
}

function Assert-HotfixFaultFixture {
  param([string]$MarkerPath, [string]$AppRoot)
  if ([string]::IsNullOrWhiteSpace($MarkerPath)) {
    throw 'Hotfix fault injection requires a fixture marker.'
  }
  $marker = (Resolve-Path -LiteralPath $MarkerPath -ErrorAction Stop).Path
  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $fixtureRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $marker)).TrimEnd('\')
  if (
    -not $fixtureRoot.StartsWith(
      $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not [string]::Equals(
      [System.IO.Path]::GetFullPath((Split-Path -Parent $AppRoot)).TrimEnd('\'),
      $fixtureRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    (Get-Content -LiteralPath $marker -Raw).Trim() -cne 'nantong-safe-hotfix-fixture-v1'
  ) {
    throw 'Hotfix fault injection is restricted to a marked System Temp fixture.'
  }
  return $marker
}

function Invoke-HotfixFaultInjection {
  param([string]$Phase, [string]$AppRoot)
  $throwPhase = [Environment]::GetEnvironmentVariable('NANTONG_HOTFIX_TEST_THROW_PHASE', 'Process')
  $pausePhase = [Environment]::GetEnvironmentVariable('NANTONG_HOTFIX_TEST_PAUSE_PHASE', 'Process')
  if ($throwPhase -cne $Phase -and $pausePhase -cne $Phase) {
    return
  }
  $markerPath = Assert-HotfixFaultFixture `
    -MarkerPath ([Environment]::GetEnvironmentVariable('NANTONG_HOTFIX_TEST_FIXTURE_MARKER', 'Process')) `
    -AppRoot $AppRoot
  if ($throwPhase -ceq $Phase) {
    throw "Injected hotfix fixture failure at phase: $Phase"
  }
  $reachedPath = "$markerPath.$Phase.reached"
  $reachedStream = [System.IO.File]::Open(
    $reachedPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read
  )
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Phase)
    $reachedStream.Write($bytes, 0, $bytes.Length)
    $reachedStream.Flush($true)
  } finally {
    $reachedStream.Dispose()
  }
  $continuePath = "$markerPath.$Phase.continue"
  $deadline = (Get-Date).AddMinutes(2)
  while (-not (Test-Path -LiteralPath $continuePath -PathType Leaf)) {
    if ((Get-Date) -ge $deadline) {
      throw "Timed out waiting for the hotfix fixture continuation at phase: $Phase"
    }
    Start-Sleep -Milliseconds 50
  }
}

function Get-TextSha256 {
  param([string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

  function Get-PathSortKey {
    param([string]$Path)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path)
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  }

function Assert-CanonicalRelativePath {
  param([string]$RelativePath)
  if (
    [string]::IsNullOrWhiteSpace($RelativePath) -or
    $RelativePath.Contains('\') -or
    $RelativePath.Contains(':') -or
    [System.IO.Path]::IsPathRooted($RelativePath)
  ) {
    throw "Non-canonical relative path: $RelativePath"
  }
  $segments = @($RelativePath.Split('/'))
  foreach ($segment in $segments) {
    if (
      [string]::IsNullOrEmpty($segment) -or
      $segment -eq '.' -or
      $segment -eq '..' -or
      $segment.EndsWith(' ') -or
      $segment.EndsWith('.')
    ) {
      throw "Non-canonical relative path: $RelativePath"
    }
  }
  $canonicalPath = $segments -join '/'
  if ($RelativePath -cne $canonicalPath) {
    throw "Non-canonical relative path: $RelativePath"
  }
  return $RelativePath
}

function Get-RequiredObjectPropertyValue {
  param(
    [object]$Object,
    [string]$Name
  )
  $property = @($Object.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
  if ($property.Count -ne 1) {
    throw "Required manifest property is missing or duplicated: $Name"
  }
  return $property[0].Value
}

function Assert-ExactObjectProperties {
  param(
    [object]$Object,
    [string[]]$ExpectedNames,
    [string]$Context
  )
  if ($null -eq $Object) {
    throw "$Context has an invalid strict schema."
  }
  $actualNames = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($actualNames.Count -ne $ExpectedNames.Count) {
    throw "$Context has unexpected or missing properties."
  }
  foreach ($expectedName in $ExpectedNames) {
    if (@($actualNames | Where-Object { $_ -ceq $expectedName }).Count -ne 1) {
      throw "$Context has unexpected or missing properties."
    }
  }
}

function Get-NonNegativeInt64ManifestValue {
  param(
    [object]$Value,
    [string]$Name
  )
  if ($null -eq $Value) {
    throw "Manifest integer property is invalid: $Name"
  }
  $typeCode = [System.Type]::GetTypeCode($Value.GetType()).ToString()
  if (@('Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64') -notcontains $typeCode) {
    throw "Manifest integer property is invalid: $Name"
  }
  $number = [int64]$Value
  if ($number -lt 0) {
    throw "Manifest integer property is invalid: $Name"
  }
  return $number
}

  function Get-RelativeUnixPath {
  param([string]$BasePath, [string]$FullPath)
  $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
  $resolvedFullPath = [System.IO.Path]::GetFullPath($FullPath)
  $prefix = $baseFullPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedFullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the expected base directory: $FullPath"
  }
  return $resolvedFullPath.Substring($prefix.Length).Replace('\', '/')
}

function Assert-SafePackagePath {
  param([string]$RelativePath)
  [void](Assert-CanonicalRelativePath -RelativePath $RelativePath)
  $relativeLower = $RelativePath.Replace('\', '/').ToLowerInvariant()
  $normalized = '/' + $relativeLower + '/'
  foreach ($segment in @('/.runtime/', '/nantong-schedule-state/', '/logs/', '/node_modules/', '/certs/')) {
    if ($normalized.Contains($segment)) {
      throw "Forbidden package content detected: $RelativePath"
    }
  }
  foreach ($pathSegment in @($relativeLower.Split('/'))) {
    if ($pathSegment.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Forbidden environment file detected: $RelativePath"
    }
  }
  $forbiddenExtensions = @(
    '.map',
    '.pem',
    '.key',
    '.pfx',
    '.p12',
    '.crt',
    '.cer',
    '.der',
    '.jks',
    '.keystore'
  )
  if ($forbiddenExtensions -contains [System.IO.Path]::GetExtension($relativeLower)) {
    throw "Forbidden source map, certificate, or private-key file detected: $RelativePath"
  }
}

function Assert-ExactPayloadFileSet {
  param(
    [string]$PackageRoot,
    [object]$Manifest
  )
  $expectedPaths = @{}
  foreach ($entry in @($Manifest.payloadFiles)) {
    $relativePath = [string]$entry.path
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    if (
      -not $relativePath.StartsWith('dist/', [System.StringComparison]::OrdinalIgnoreCase) -or
      @($relativePath.Split('/')) -contains '..'
    ) {
      throw "Manifest payload path is outside dist: $relativePath"
    }
    if ($expectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate manifest payload path: $relativePath"
    }
    $expectedPaths[$relativePath] = $true
  }

  $actualPaths = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'dist') -File -Recurse)) {
    $relativePath = Get-RelativeUnixPath -BasePath $PackageRoot -FullPath $file.FullName
    if (-not $expectedPaths.ContainsKey($relativePath)) {
      throw "Unexpected payload file not declared by manifest: $relativePath"
    }
    $actualPaths[$relativePath] = $true
  }
  foreach ($relativePath in @($expectedPaths.Keys)) {
    if (-not $actualPaths.ContainsKey($relativePath)) {
      throw "Manifest payload file is missing: $relativePath"
    }
  }
}

function Assert-ExactSupportFileSet {
  param(
    [string]$PackageRoot,
    [object]$Manifest
  )
  $expectedPaths = @{}
  foreach ($entry in @($Manifest.supportFiles)) {
    $relativePath = [string]$entry.path
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    if (
      -not $relativePath.StartsWith('operations/', [System.StringComparison]::OrdinalIgnoreCase) -or
      @($relativePath.Split('/')) -contains '..'
    ) {
      throw "Manifest support path is outside operations: $relativePath"
    }
    if ($expectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate manifest support path: $relativePath"
    }
    $expectedPaths[$relativePath] = $true
  }

  $actualPaths = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'operations') -File -Recurse)) {
    $relativePath = Get-RelativeUnixPath -BasePath $PackageRoot -FullPath $file.FullName
    if (-not $expectedPaths.ContainsKey($relativePath)) {
      throw "Unexpected support file not declared by manifest: $relativePath"
    }
    $actualPaths[$relativePath] = $true
  }
  foreach ($relativePath in @($expectedPaths.Keys)) {
    if (-not $actualPaths.ContainsKey($relativePath)) {
      throw "Manifest support file is missing: $relativePath"
    }
  }
}

function Assert-ExactControlFileSet {
  param(
    [string]$PackageRoot,
    [object]$Manifest
  )
  $requiredControlPaths = @('INSTALL-HOTFIX.ps1', 'README.md')
  $expectedPaths = @{}
  foreach ($entry in @($Manifest.controlFiles)) {
    Assert-ExactObjectProperties `
      -Object $entry `
      -ExpectedNames @('path', 'sha256', 'size') `
      -Context 'A hotfix control-file entry'
    $relativePath = [string]$entry.path
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    if ($requiredControlPaths -cnotcontains $relativePath) {
      throw "Unexpected manifest control-file path: $relativePath"
    }
    if ($expectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate manifest control-file path: $relativePath"
    }
    $expectedPaths[$relativePath] = $true
  }
  if ($expectedPaths.Count -ne $requiredControlPaths.Count) {
    throw 'The manifest control-file set is incomplete.'
  }

  $manifestPath = Join-Path $PackageRoot 'hotfix-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'The hotfix manifest trust root is missing.'
  }
  $allowedDirectoryNames = @('dist', 'release-root', 'operations')
  $actualPaths = @{}
  foreach ($item in @(Get-ChildItem -LiteralPath $PackageRoot -Force)) {
    if ($item.PSIsContainer) {
      if ($allowedDirectoryNames -cnotcontains $item.Name) {
        throw "Unexpected package root directory: $($item.Name)"
      }
      continue
    }
    if ($item.Name -ceq 'hotfix-manifest.json') {
      continue
    }
    if (-not $expectedPaths.ContainsKey($item.Name)) {
      throw "Unexpected package root file not declared by manifest: $($item.Name)"
    }
    $actualPaths[$item.Name] = $true
  }
  foreach ($relativePath in @($expectedPaths.Keys)) {
    if (-not $actualPaths.ContainsKey($relativePath)) {
      throw "Manifest control file is missing: $relativePath"
    }
  }
}

function Assert-ExactReleaseFileSet {
  param(
    [string]$PackageRoot,
    [object]$Manifest
  )
  $expectedPaths = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $relativePath = [string]$entry.path
    $targetPath = [string]$entry.targetPath
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    [void](Assert-CanonicalRelativePath -RelativePath $targetPath)
    if ($null -eq $entry.baselineExisted) {
      throw "Manifest release-root baseline state is missing: $relativePath"
    }
    if ([bool]$entry.baselineExisted -and [string]::IsNullOrWhiteSpace([string]$entry.baselineSha256)) {
      throw "Manifest release-root baseline hash is missing: $relativePath"
    }
    if (
      -not $relativePath.StartsWith('release-root/', [System.StringComparison]::OrdinalIgnoreCase) -or
      @($relativePath.Split('/')) -contains '..' -or
      @($targetPath.Split('/')) -contains '..' -or
      $relativePath.Substring('release-root/'.Length) -ne $targetPath
    ) {
      throw "Manifest release-root path is invalid: $relativePath"
    }
    if ($expectedPaths.ContainsKey($relativePath)) {
      throw "Duplicate manifest release-root path: $relativePath"
    }
    $expectedPaths[$relativePath] = $true
  }

  $actualPaths = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'release-root') -File -Recurse)) {
    $relativePath = Get-RelativeUnixPath -BasePath $PackageRoot -FullPath $file.FullName
    if (-not $expectedPaths.ContainsKey($relativePath)) {
      throw "Unexpected release-root file not declared by manifest: $relativePath"
    }
    $actualPaths[$relativePath] = $true
  }
  foreach ($relativePath in @($expectedPaths.Keys)) {
    if (-not $actualPaths.ContainsKey($relativePath)) {
      throw "Manifest release-root file is missing: $relativePath"
    }
  }
}

function Assert-NoReparsePointsOrAlternateDataStreams {
  param([string]$Root)

  $items = @((Get-Item -LiteralPath $Root -Force)) + @(
    Get-ChildItem -LiteralPath $Root -Force -Recurse
  )
  foreach ($item in $items) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in staged runtime content: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
      foreach ($stream in @(Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction SilentlyContinue)) {
        if (@(':$DATA', '$DATA') -notcontains [string]$stream.Stream) {
          throw "Alternate data streams are forbidden in staged runtime content: $($item.FullName)"
        }
      }
    }
  }
}

function Assert-NoReparsePoints {
  param([string]$Root)

  $items = @((Get-Item -LiteralPath $Root -Force)) + @(
    Get-ChildItem -LiteralPath $Root -Force -Recurse
  )
  foreach ($item in $items) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in runtime content: $($item.FullName)"
    }
  }
}

function Get-FinalPathByHandle {
  param([string]$Path)
  $finalPath = [NantongHotfixNativeMethods]::GetFinalPath(
    [System.IO.Path]::GetFullPath($Path)
  )
  if ($finalPath.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
    return '\\' + $finalPath.Substring(8)
  }
  if ($finalPath.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $finalPath.Substring(4)
  }
  return $finalPath
}

function Assert-PathHasNoReparsePointAncestors {
  param([string]$Path)
  $currentPath = [System.IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    if (Test-Path -LiteralPath $currentPath) {
      $item = Get-Item -LiteralPath $currentPath -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "A reparse-point ancestor is forbidden in a deployment path: $currentPath"
      }
    }
    $parentDirectory = [System.IO.Directory]::GetParent($currentPath)
    if ($null -eq $parentDirectory) {
      break
    }
    $currentPath = $parentDirectory.FullName
  }
}

function Assert-FinalPathContainedByRoot {
  param(
    [string]$Root,
    [string]$Path
  )
  $rootFinalPath = Get-FinalPathByHandle -Path $Root
  $existingPath = [System.IO.Path]::GetFullPath($Path)
  while (-not (Test-Path -LiteralPath $existingPath)) {
    $parentPath = Split-Path -Parent $existingPath
    if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $existingPath) {
      throw "A deployment path has no verifiable existing parent: $Path"
    }
    $existingPath = $parentPath
  }
  $finalExistingPath = Get-FinalPathByHandle -Path $existingPath
  $rootPrefix = $rootFinalPath.TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
  if (
    -not [string]::Equals(
      $finalExistingPath.TrimEnd('\'),
      $rootFinalPath.TrimEnd('\'),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    -not $finalExistingPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "A deployment path escapes the final application root: $Path"
  }
}

function Assert-NoAlternateDataStreamsAtPath {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  foreach ($stream in @(Get-Item -LiteralPath $Path -Stream * -ErrorAction SilentlyContinue)) {
    if (@(':$DATA', '$DATA') -notcontains [string]$stream.Stream) {
      throw "Alternate data streams are forbidden in deployment paths: $Path"
    }
  }
}

function Assert-DeploymentPathTopology {
  param(
    [string]$AppRoot,
    [string]$PackageRoot,
    [string[]]$DeploymentPaths,
    [object]$Manifest
  )
  Assert-PathHasNoReparsePointAncestors -Path $AppRoot
  Assert-PathHasNoReparsePointAncestors -Path $PackageRoot
  Assert-NoReparsePointsOrAlternateDataStreams -Root $PackageRoot
  foreach ($path in @($DeploymentPaths)) {
    Assert-PathHasNoReparsePointAncestors -Path $path
    Assert-FinalPathContainedByRoot -Root $AppRoot -Path $path
  }
  foreach ($entry in @($Manifest.releaseFiles)) {
    $targetPath = Resolve-AppRootTargetPath -Root $AppRoot -RelativePath ([string]$entry.targetPath)
    Assert-PathHasNoReparsePointAncestors -Path $targetPath
    Assert-FinalPathContainedByRoot -Root $AppRoot -Path $targetPath
    Assert-NoAlternateDataStreamsAtPath -Path $targetPath
  }
}

function Open-VerifiedIntegrityHandles {
  param(
    [string]$Root,
    [object[]]$Entries
  )
  $handles = New-Object 'System.Collections.Generic.List[object]'
  try {
    foreach ($entry in @($Entries)) {
      $relativePath = [string]$entry.path
      $fullPath = Join-Path $Root $relativePath.Replace('/', '\')
      $stream = [System.IO.File]::Open(
        $fullPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete)
      )
      try {
        if ($stream.Length -ne [int64]$entry.size) {
          throw "A held integrity file changed size: $relativePath"
        }
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
          $actualHash = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
          $algorithm.Dispose()
        }
        if ($actualHash -cne [string]$entry.sha256) {
          throw "A held integrity file changed hash: $relativePath"
        }
        $stream.Position = 0
        [void]$handles.Add([pscustomobject]@{
          relativePath = $relativePath
          size = [int64]$entry.size
          sha256 = [string]$entry.sha256
          stream = $stream
        })
        $stream = $null
      } finally {
        if ($stream) {
          $stream.Dispose()
        }
      }
    }
    return $handles
  } catch {
    foreach ($handle in $handles) {
      $handle.stream.Dispose()
    }
    throw
  }
}

function Get-HeldIntegrityHandle {
  param(
    [object[]]$IntegrityHandles,
    [string]$RelativePath
  )
  $matches = @(
    $IntegrityHandles |
      Where-Object { [string]$_.relativePath -ceq $RelativePath }
  )
  if ($matches.Count -ne 1) {
    throw "A held integrity handle is missing or duplicated: $RelativePath"
  }
  return $matches[0]
}

function Write-HeldIntegrityFile {
  param(
    [object[]]$IntegrityHandles,
    [string]$RelativePath,
    [string]$Destination
  )
  $held = Get-HeldIntegrityHandle `
    -IntegrityHandles $IntegrityHandles `
    -RelativePath $RelativePath
  if (Test-Path -LiteralPath $Destination) {
    throw "A held integrity destination already exists: $Destination"
  }
  $destinationParent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  $destinationStream = [System.IO.File]::Open(
    $Destination,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $held.stream.Position = 0
    $held.stream.CopyTo($destinationStream)
    $destinationStream.Flush($true)
  } finally {
    $destinationStream.Dispose()
  }
  $destinationFile = Get-Item -LiteralPath $Destination -Force
  if ($destinationFile.Length -ne [int64]$held.size) {
    throw "A held integrity destination has the wrong size: $RelativePath"
  }
  $destinationHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($destinationHash -cne [string]$held.sha256) {
    throw "A held integrity destination has the wrong hash: $RelativePath"
  }
}

function Close-IntegrityHandles {
  param([AllowNull()][object]$Handles)
  if ($null -eq $Handles) {
    return
  }
  foreach ($handle in @($Handles)) {
    $handle.stream.Dispose()
  }
}

function Assert-ManifestEntryIntegrity {
  param(
    [string]$Root,
    [object[]]$Entries
  )

  foreach ($entry in @($Entries)) {
    $relativePath = [string]$entry.path
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    $fullPath = Join-Path $Root $relativePath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Integrity-checked file is missing: $relativePath"
    }
    $actualSize = (Get-Item -LiteralPath $fullPath).Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne [int64]$entry.size -or $actualHash -cne [string]$entry.sha256) {
      throw "Integrity-checked file hash or size mismatch: $relativePath"
    }
  }
}

function Assert-HotfixManifestContract {
  param(
    [string]$PackageRoot,
    [object]$Manifest
  )

  if (
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'schemaVersion') -ne 6 -or
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'installedReleaseReceiptSchemaVersion') -ne 2 -or
    [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'releaseMode') -cne 'complete-runtime-atomic-switch' -or
    [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyTreeMode') -cne 'verified-existing-production-tree' -or
    [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyProofAlgorithm') -cne 'sha256-package-lock-production-closure-v1' -or
    [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientProofAlgorithm') -cne 'sha256-active-client-closure-v2'
  ) {
    throw 'The hotfix manifest release or proof schema is unsupported.'
  }

  foreach ($hashName in @(
    'releaseToolFingerprint', 'installerSha256', 'recoveryLauncherSha256',
    'dependencyVerifierSha256', 'clientVerifierSha256',
    'dependencyLockPhysicalTreeFingerprint',
    'dependencyInstalledPhysicalTreeFingerprint',
    'activeClientAssetFingerprint'
  )) {
    if ([string](Get-RequiredObjectPropertyValue -Object $Manifest -Name $hashName) -cnotmatch '^[0-9a-f]{64}$') {
      throw "The hotfix manifest proof hash is invalid: $hashName"
    }
  }
  if (
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyPackageCount') -le 0 -or
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyFileCount') -le 0 -or
    [int64](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'dependencyBytes') -le 0 -or
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientAssetCount') -le 0 -or
    [int](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientChunkCount') -le 0
  ) {
    throw 'The hotfix manifest proof counts are invalid.'
  }

  $controlInstallerEntries = @(
    @((Get-RequiredObjectPropertyValue -Object $Manifest -Name 'controlFiles')) |
      Where-Object { [string]$_.path -ceq 'INSTALL-HOTFIX.ps1' }
  )
  if (
    $controlInstallerEntries.Count -ne 1 -or
    [string]$controlInstallerEntries[0].sha256 -cne [string]$Manifest.installerSha256 -or
    (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$Manifest.installerSha256
  ) {
    throw 'The running installer is not the installer bound to the hotfix manifest.'
  }

  $supportProofs = @{
    'operations/deploy/hotfix-recovery-start.ps1' = 'recoveryLauncherSha256'
    'operations/scripts/verify-hotfix-dependency-transition.mjs' = 'dependencyVerifierSha256'
    'operations/scripts/verify-client-asset-graph.mjs' = 'clientVerifierSha256'
  }
  foreach ($supportPath in @($supportProofs.Keys)) {
    $entries = @(@($Manifest.supportFiles) | Where-Object { [string]$_.path -ceq $supportPath })
    $hashName = [string]$supportProofs[$supportPath]
    if ($entries.Count -ne 1 -or [string]$entries[0].sha256 -cne [string]$Manifest.$hashName) {
      throw "The hotfix support proof is not bound to the manifest: $supportPath"
    }
  }

  $payloadByPath = @{}
  foreach ($entry in @($Manifest.payloadFiles)) {
    $payloadByPath[[string]$entry.path] = $entry
  }
  $activeClientEntries = @((Get-RequiredObjectPropertyValue -Object $Manifest -Name 'activeClientFiles'))
  if ($activeClientEntries.Count -ne [int]$Manifest.activeClientAssetCount -or $activeClientEntries.Count -gt 2048) {
    throw 'The active client closure count does not match the hotfix manifest.'
  }
  $clientPaths = @{}
  $clientDescriptors = @(
    foreach ($entry in $activeClientEntries) {
      Assert-ExactObjectProperties `
        -Object $entry `
        -ExpectedNames @('path', 'sha256', 'size') `
        -Context 'A hotfix active-client entry'
      $relativePath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.path)
      if (-not $relativePath.StartsWith('dist/client/', [System.StringComparison]::Ordinal)) {
        throw "The active client closure contains a path outside dist/client: $relativePath"
      }
      if ($clientPaths.ContainsKey($relativePath) -or -not $payloadByPath.ContainsKey($relativePath)) {
        throw "The active client closure contains a duplicate or non-payload path: $relativePath"
      }
      $clientPaths[$relativePath] = $true
      $payloadEntry = $payloadByPath[$relativePath]
      $size = Get-NonNegativeInt64ManifestValue -Value $entry.size -Name "active-client.size:$relativePath"
      if (
        [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [int64]$payloadEntry.size -ne $size -or
        [string]$payloadEntry.sha256 -cne [string]$entry.sha256
      ) {
        throw "The active client closure does not match its payload entry: $relativePath"
      }
      $assetPath = $relativePath.Substring('dist/client/'.Length)
      "asset`0$assetPath`0$size`0$([string]$entry.sha256)"
    }
  )
  foreach ($requiredClientPath in @('dist/client/index.html', 'dist/client/main.js', 'dist/client/main.css')) {
    if (-not $clientPaths.ContainsKey($requiredClientPath)) {
      throw "The active client closure is missing: $requiredClientPath"
    }
  }
  $clientMaterial = @($clientDescriptors | Sort-Object { Get-PathSortKey -Path ([string]$_) }) -join "`n"
  if ((Get-TextSha256 -Text $clientMaterial) -cne [string]$Manifest.activeClientAssetFingerprint) {
    throw 'The active client closure fingerprint does not match its manifest entries.'
  }
}

function Assert-StageIntegrity {
  param(
    [string]$StageRoot,
    [object]$Manifest
  )

  Assert-ExactPayloadFileSet -PackageRoot $StageRoot -Manifest $Manifest
  Assert-ExactReleaseFileSet -PackageRoot $StageRoot -Manifest $Manifest
  Assert-ManifestEntryIntegrity -Root $StageRoot -Entries @($Manifest.payloadFiles)
  Assert-ManifestEntryIntegrity -Root $StageRoot -Entries @($Manifest.releaseFiles)
  Assert-NoReparsePointsOrAlternateDataStreams -Root $StageRoot

  $allowedTopLevel = @('dist', 'release-root')
  foreach ($item in @(Get-ChildItem -LiteralPath $StageRoot -Force)) {
    if ($allowedTopLevel -notcontains $item.Name) {
      throw "Unexpected staged runtime entry: $($item.Name)"
    }
  }
}

function Open-VerifiedStageIntegrityHandles {
  param(
    [string]$StageRoot,
    [object]$Manifest
  )

  Assert-ExactPayloadFileSet -PackageRoot $StageRoot -Manifest $Manifest
  Assert-ExactReleaseFileSet -PackageRoot $StageRoot -Manifest $Manifest
  Assert-NoReparsePointsOrAlternateDataStreams -Root $StageRoot
  $allowedTopLevel = @('dist', 'release-root')
  foreach ($item in @(Get-ChildItem -LiteralPath $StageRoot -Force)) {
    if ($allowedTopLevel -notcontains $item.Name) {
      throw "Unexpected staged runtime entry: $($item.Name)"
    }
  }
  return Open-VerifiedIntegrityHandles `
    -Root $StageRoot `
    -Entries (@($Manifest.payloadFiles) + @($Manifest.releaseFiles))
}

function Assert-PackageAndStageIntegrity {
  param(
    [string]$PackageRoot,
    [string]$StageRoot,
    [object]$Manifest
  )

  Assert-ExactPayloadFileSet -PackageRoot $PackageRoot -Manifest $Manifest
  Assert-ExactSupportFileSet -PackageRoot $PackageRoot -Manifest $Manifest
  Assert-ExactReleaseFileSet -PackageRoot $PackageRoot -Manifest $Manifest
  Assert-ExactControlFileSet -PackageRoot $PackageRoot -Manifest $Manifest
  Assert-ManifestEntryIntegrity -Root $PackageRoot -Entries @($Manifest.payloadFiles)
  Assert-ManifestEntryIntegrity -Root $PackageRoot -Entries @($Manifest.supportFiles)
  Assert-ManifestEntryIntegrity -Root $PackageRoot -Entries @($Manifest.releaseFiles)
  Assert-ManifestEntryIntegrity -Root $PackageRoot -Entries @($Manifest.controlFiles)
  Assert-NoReparsePointsOrAlternateDataStreams -Root $PackageRoot
  Assert-StageIntegrity -StageRoot $StageRoot -Manifest $Manifest
}

function Resolve-AppRootTargetPath {
  param(
    [string]$Root,
    [string]$RelativePath
  )
  [void](Assert-CanonicalRelativePath -RelativePath $RelativePath)
  $normalized = $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  if ([System.IO.Path]::IsPathRooted($normalized) -or @($normalized.Replace('\', '/').Split('/')) -contains '..') {
    throw "Release target path is invalid: $RelativePath"
  }
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $targetPath = [System.IO.Path]::GetFullPath((Join-Path $rootPath $normalized))
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $targetPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release target path escapes the application root: $RelativePath"
  }
  return $targetPath
}

function Get-ServerBaselineEntryReason {
  param([object]$Entry)
  $reasonProperty = @($Entry.PSObject.Properties | Where-Object { $_.Name -ceq 'reason' })
  if ($reasonProperty.Count -eq 0) {
    return $null
  }
  if ($reasonProperty.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$reasonProperty[0].Value)) {
    throw 'Server baseline entry contains an invalid metadata-only reason.'
  }
  return [string]$reasonProperty[0].Value
}

function Assert-ServerBaselineEntryReasonPath {
  param(
    [string]$RelativePath,
    [AllowNull()]
    [object]$Reason
  )
  if ($null -eq $Reason) {
    if ($RelativePath -match '\.map$') {
      throw "Server baseline source-map entry is missing its metadata-only reason: $RelativePath"
    }
    return
  }
  $validReasonPath = switch ($Reason) {
    'source-map-content-not-exported' {
      $RelativePath -match '^dist/(server|shared|client)/.+\.map$'
      break
    }
    'unreferenced-client-chunk-content-not-exported' {
      $RelativePath -match '^dist/client/chunks/[^/]+\.[0-9a-f]{8,64}(?:\.legacy)?\.(?:js|css)$'
      break
    }
    default { $false }
  }
  if (-not $validReasonPath) {
    throw "Unsupported server baseline metadata-only reason or path: $RelativePath"
  }
}

$knownObsoleteRuntimeArtifactProofs = @{
  'dist/client/chunks/1044.f8b8f5d2.js' = '29428:38b7302634334bff5c49c5d3cc3fc8da7a3305981a5f95b99affaac251ed7f4c'
  'dist/client/chunks/1047.e8a1aa34.js' = '42930:dd310d1230d044f68e046e9333bb9c5ceaf83d97019a38a5459cc73b220e92c2'
  'dist/client/chunks/1154.6cbb441e.js' = '64841:c8c95f4aa727a79ff51d9808df6e1ade5c3ba7397cd35b80bfb61381393d0293'
  'dist/client/chunks/1274.9c1064b2.js' = '20418:af2cd308a15eb92474ae549dd26213f55ac3eb6dd27244844d6aac8cb0f75c5c'
  'dist/client/chunks/1383.f001a7b9.js' = '62977:e02f12443c3cbdfa52cf266929200a78e329860ea714690a649220f30842969f'
  'dist/client/chunks/145.5073fc42.js' = '34855:2781ae21d66904d34152ad861f82df506eb50e3255130f6f47960a99da619d54'
  'dist/client/chunks/1559.0839dfd4.js' = '28677:c8633f2af51197514bb89cb075b812f0a8b13116e3ad9db39829239c898bc1de'
  'dist/client/chunks/157.8ea241f9.js' = '12031:abfb3a8affef696e00eae77f55e40197f776ecd788df5d00045265bca5caf590'
  'dist/client/chunks/1736.907730ef.js' = '36504:0d7423d41a0e8e55e99831c21fa1090642e2dd0b840f525ea7e6840980461846'
  'dist/client/chunks/1894.3f5b3004.js' = '19223:a8285df26758d855f6569892682bf3df2ed3021465aabd72f454efb2a4a27428'
  'dist/client/chunks/2104.8c1ea73b.js' = '70864:2c20e6711d35339b6106e1350b962289837c9b75f910899e6d6a44b1b0957e89'
  'dist/client/chunks/2125.efc88aa2.js' = '569106:cdcda7456e4ee531d4b675931cd7a823fa2771f47c7cbde2b2de33f173f92fb6'
  'dist/client/chunks/2400.ad25ffca.js' = '17353:c53bd7e29a8b9cc935ca58e4ce739747851cd0e33dcc5bb6f43709f774a42d43'
  'dist/client/chunks/2653.df83899f.js' = '23479:297dbe0a2892fd06f6a01e854d2fe506a0f31ae8192fb63a44a474fdb3c10064'
  'dist/client/chunks/2727.056fcbcd.js' = '9894:6fff67d4e9bfaf8f832c811a995bdc5d4688a30f12e4b77d71041416f2e72281'
  'dist/client/chunks/3004.34896cb2.js' = '70338:285f70eb1e8cb7ac2d019dbc860a572c659c0540129fbf6bdf091a2b6bc7cc6d'
  'dist/client/chunks/3108.f104d16d.js' = '58484:278e36ea23aa446aed1ec38c5da957e345debe4de0733d428fbdc9e0f7294a4d'
  'dist/client/chunks/3291.15a08cab.js' = '78788:c21b90003b750b846a9e6afc62683f74c48fe36310bb3d4586c6df49a867c996'
  'dist/client/chunks/3358.5cdd0132.js' = '25635:48cea5289e7e6fda1e13d752262321e2719a8369e7ce3552d5acf15a4ebb683d'
  'dist/client/chunks/3433.1dd88e34.js' = '59168:bcf85d66d75b5e82eea21a5c2c7717683490144cda10d71ba96722648e166ed5'
  'dist/client/chunks/3702.a4187b41.js' = '35136:4aa9cb1b9939b05a9024750560c640bba9e2331ad71bde78bcb30723a992748e'
  'dist/client/chunks/4014.5b3fbef5.js' = '7457:4e9f340e24f3613e64daa09c5e7cfb342a5f6e3dcfeb1b12c60f54ecdb149c14'
  'dist/client/chunks/4154.1971ed6e.js' = '322383:0d4d8195f11daeb1b530247449797f8747157229870fc07e1917aa0bf4475917'
  'dist/client/chunks/4177.bcb261e0.js' = '86234:9faccc7ee2c73047668ed9656358cacda9fff37f3798c817694d4562a184cfa7'
  'dist/client/chunks/4263.998ddf32.js' = '148722:9dd8bad56dc425d144d565352a5c1ab30fbc05fbc3f3ad835a8b1d1d01b17c18'
  'dist/client/chunks/4364.c4fccd7f.js' = '21749:7ce22c419de4e8987b97c0df338f0a15f337c42bc6844cdba76a957b2aad2d0f'
  'dist/client/chunks/4409.1bcc3710.js' = '6645:5271585f2425e1f2b7ea4ceccf614884695674e3371345ce1e4ab7a7cac369d9'
  'dist/client/chunks/4413.9aa4039c.js' = '313:dc469bdbc2b3e55019c9b3128cd077fd0d94130b0299f5f85c72a2e857f70b0f'
  'dist/client/chunks/4537.55d4a271.js' = '108903:3dc9d8378732046342ec7e25a4dfa592ef17ba844e6bff223268ecd15992f78c'
  'dist/client/chunks/4565.5ee72bb0.js' = '61795:304448647120a45b0c80fb261aa3560df4dfef9e4f31a199bdf3124d3feba2ac'
  'dist/client/chunks/4565.6153de0a.css' = '35008:d048a2916a13562124644c3f5360c85a60d91a49c738719a060b7a476ccbde1d'
  'dist/client/chunks/4565.6153de0a.legacy.css' = '34609:bf5652f9525397abd926bbf3b07773a660f58ed37743ea8428daf34473dbae0e'
  'dist/client/chunks/4570.b1bfa5ec.js' = '64386:8447bc1e560ae62338ea73cfe1005f34d809b27c2d7c100101c05677f8be5788'
  'dist/client/chunks/4594.cbd566e8.js' = '8212:7b30e3fe2085441f4ecd928987ecdbc69fad7522de7af2dabd107cf58b15ecaa'
  'dist/client/chunks/4687.fb154e4a.js' = '78330:ff5272db2e4bbbd3fb127fb719559317398b5d89ae83aa8c0a014f412865d584'
  'dist/client/chunks/4831.97eec9ea.js' = '69322:fc30a7d756ba9b213d1d6089078fef472d48c0222c6d43099d8ed23c773bf0bf'
  'dist/client/chunks/4987.5cff2424.js' = '31449:0f1cd0210c3b6b496f36d7c79fa93540ee353e11b47e8fd287eb693d72de5ce7'
  'dist/client/chunks/5031.46a598bb.js' = '87832:ef6c43d0b040c004ba20c443b4e1beeb5bc279ac5e67c4e2e9f62d49d45f3bb3'
  'dist/client/chunks/507.c67ec87e.js' = '11001:f5eda5065ed9f1bcb9bf8a1ca58fda66b5b7422ca58beabfd191fe001ed65f42'
  'dist/client/chunks/5084.dd1485bc.js' = '36252:f7e4d2069c13dd2f5c912fd5e90e5b09935be49cb6bbd77db66c3cb1a1bf0e01'
  'dist/client/chunks/5339.a68a0e74.js' = '253543:affa38bb43a46e61743e68919ead564784e2c2d01ecb56f64a71e2a49b2a465e'
  'dist/client/chunks/5408.20a3f4d1.css' = '31022:02cb8246736cdd0e30c9a13fa6d2cc1def040796dfdece85c3359aac3eaa3682'
  'dist/client/chunks/5408.20a3f4d1.legacy.css' = '30857:33a89578e4fa30a06793fa2675cb9aa13624d2fbd49f3af09e92989dc4074b4b'
  'dist/client/chunks/5408.3f006632.js' = '64104:1804ea32b35521ccdc37b458d4728a965b06df2ca176cf2154116109d8c5cf0c'
  'dist/client/chunks/5545.f52d4316.js' = '47690:81af723ff0a7d5a112688f1b21ad0ed5697393a29fd3d2448084ae4f0e3c793f'
  'dist/client/chunks/5737.e8d019c1.js' = '17620:8b6ba34543c154d4a527d4a81ce26b9983c25e45f9ee674e43ac3f0713682505'
  'dist/client/chunks/5768.83048d3c.js' = '2560:95935c480f5a39f317dd0662a35fafaac437997b262b6267a2155f67efa3abeb'
  'dist/client/chunks/5817.aac275a5.js' = '35661:0fe99d3b7adc67b454ad767f1baea30765e6fb728e6400a80802600019824274'
  'dist/client/chunks/5933.af933fc2.js' = '15461:49a25481db44018be574bf2133b64634888505dea17b5000d337b37b262e6ece'
  'dist/client/chunks/6109.397c9da1.js' = '119304:1ccdee2cb578fd6f068465ac72c6b7c6175235d1030489c7260c2db5356f1d8e'
  'dist/client/chunks/6212.c0479000.js' = '27401:bc1a604a9cfd0206724053cbf8ee9278d9956455a50162233ae7b2bc2ccb55c5'
  'dist/client/chunks/6313.9a9c7cb7.js' = '398817:a82d6016de8060a156e415addd4c9302edc2716252c216e1e78749a14f51fb6d'
  'dist/client/chunks/6375.71788dde.js' = '112537:94b593dcc2ddf440e7a8d37b6823e86d55508290d8c18e644162265a89a64ed0'
  'dist/client/chunks/6382.ccb67b1f.js' = '78488:a6c8930208e87019db31b78b5cae81fcd4b61abb1ba68fb4f4c956a1fec392de'
  'dist/client/chunks/6514.4ca771bd.js' = '59912:640db0d341aa2bcfef2256f720e26e00064021677fecaeda00d3f82a1fc7fc5c'
  'dist/client/chunks/6534.fd05a659.js' = '58906:a99a368a44a9e6d3d525cef9d102f9b2560d8ea6d71b12a8808360d505518e6b'
  'dist/client/chunks/6551.319eeb96.js' = '18538:d7d9c4b5fa73a91b9f9e48d541b13735b4b23cc79366b67c5350edd2be54f723'
  'dist/client/chunks/6698.e157ea46.js' = '40700:4d3ca1b48e3dbf4aa85b9e0ae885a4432551190c4ac5bdce24ba77710719756d'
  'dist/client/chunks/6735.9687930c.js' = '58042:c3370ae8beb4fac32ecc16990be9ae6ec07e77330ca9d5805085a24b389a6fbb'
  'dist/client/chunks/6921.2cf69e38.js' = '58072:0639c34a22d5f6f9ec8382b0ba2726f7b9aca60176d9a87e9ca7316a2cd3e5cf'
  'dist/client/chunks/6921.b34e80b8.css' = '32632:93aac0f8e0325c15861df3369e86a49d93e4e221d4593ce3b6e850db6e9c56c3'
  'dist/client/chunks/6921.b34e80b8.legacy.css' = '32253:fcae6b9f1b03f944799e304ab952ac33f1e7b78de71abaf0f36d2a26e5bbd530'
  'dist/client/chunks/6968.ace14253.js' = '190:8374858acbc524842b6adaf01e9c1b6516894c54585f5dfaf7b9386bbfe93864'
  'dist/client/chunks/7172.a7103389.js' = '35379:ffc1a1836e4894731da29ee9969fb834b5be156ab2813feb19470b3d118fc1e8'
  'dist/client/chunks/7449.69008ff3.js' = '10619:68db76fcb3e20077beeb02fd2881ab067498bf7e52f22db1c62876755bd4fa3c'
  'dist/client/chunks/7708.1275aaee.js' = '10153:601e138bb9a4ef4070505eb5fa19f7cb73d9c54950a2546ae079332be1445966'
  'dist/client/chunks/7977.d2ca125b.js' = '11721:45b09ca2f34f35fae74f4a99241447977e69b846e901aa760a024c75c4ad9867'
  'dist/client/chunks/7994.5b2761b2.js' = '19296:61054653806488beacfa4f6952ae409fe184f30bfb350e30fea99e8be8464f01'
  'dist/client/chunks/8118.0e26dd28.js' = '117604:d0adec4768e2796243244bf107d578bf1b26c063210eece7d6b7b37099e64ddb'
  'dist/client/chunks/8118.97fb1aba.css' = '49454:edd0988f446371c9c7c05f594fd0bcfecc0c4a1373c6c9b28ee57d64b360b9ae'
  'dist/client/chunks/8118.97fb1aba.legacy.css' = '49065:7cdb91d1200cf3865e19225952faec0a91f882bd6e63fa8b645d2b674a35be91'
  'dist/client/chunks/818.addfbdab.js' = '85059:15f5ade5f3a2a36bc7256b229cb4cb7b90cf4e3828d52bbef4a3d6e5e0a9fe0c'
  'dist/client/chunks/8685.759d65a1.js' = '12357:14dfbd4634d6b98c9ee3fa7b625377ef3ef80148e8bf70254b9f29b76353fd58'
  'dist/client/chunks/8706.018fd4bc.js' = '11320:e904e6f39a4cb7f5b7a2d21386446ccf4374a0ce3df18b1db44291bc28f3b271'
  'dist/client/chunks/8785.5e57c9ae.js' = '18560:74eee43d07f6c6f5649f6b24b22efe0e78d36288967bef2e01c4e4059ba5fb1d'
  'dist/client/chunks/8798.7d6d88df.js' = '50088:7d072a17bd2f34b0b2802d307b70f6c594752f8d8a1055ff9a65314b0245ee11'
  'dist/client/chunks/8851.cd3e38c5.js' = '74529:49f7a70d33a549bd00950723b7461ab868a20fe422517ecb0cc307540f1a6683'
  'dist/client/chunks/8897.c09059ad.css' = '58222:97cf6194bef16964c8a2da0333efb7771c2e5a4bf2219c1f82adeecdc8b5861c'
  'dist/client/chunks/8897.c09059ad.legacy.css' = '57703:938305e781653315016cd2fe568667e2975c9ef28e88177d43a94c642f967791'
  'dist/client/chunks/8897.f08d32eb.js' = '145842:34f7ab25600bd4ca529eac618241ac30c76d4006044f2d211d9287a6f750aeaf'
  'dist/client/chunks/8915.ec59151c.js' = '23296:df33f993fb1325f095c90dfdf9035661361365fc4f063f47c51bad96fcde1903'
  'dist/client/chunks/8975.4738d0a4.js' = '10338:e1f733985371a391c4bc68e6d55c5503997bad5a5abd3c4f6f9da65e04f9ccae'
  'dist/client/chunks/9025.00e78727.js' = '54712:3b3d9cc0ca70b9b551b3a2cadec1654c6887c71929970a75916fc1857c48f3c6'
  'dist/client/chunks/9078.ab5f3231.js' = '54152:9346c78a88e6955c8c6e68c386b1628b7be667437d5a75fcfdec5b14f1392e33'
  'dist/client/chunks/9168.ca1a3167.js' = '203936:4cc84c89de1b8edc0d767d82df3e772274a7ba27f29c39502a4175717462fe4b'
  'dist/client/chunks/9227.ff2fa5bf.js' = '15607:2b273775c8b5fe0bce8dd5fcece2fa086612a3217c0f5addf20d0460b91c2f0f'
  'dist/client/chunks/9956.c14cab3b.js' = '33559:323be7f02821d9d70cf9e0af98786a65b4a9c0e03faa9a680e82aa547b8c5097'
  'dist/client/src/api/index.ts' = '14351:2f664ec43388abfb83cbc180789be9cae8fa9583e70e360fe71d25a54c14ad9e'
  'dist/client/src/app.tsx' = '1163:00c96974d4e2605aaa0a94fded8cb813ccc1787677840936f591d04a30bafa59'
  'dist/client/src/components/Layout.tsx' = '20910:cb96d2c871ea105dc63e8ea87f10d5d08678ebf2e7b2284368efc8e83f459b47'
  'dist/client/src/pages/DutyStaffRepair/index.tsx' = '14032:cf5d4725e338f62d2391629bb03e578a01f8b7de5cbafa0e78a09f50e8929dc0'
  'dist/client/chunks/1044.dd1408be.js' = '29428:46f1325dcc712b5414a708b258cc3b0f1b3b7714a8d611d0b7c14db293d2888e'
  'dist/client/chunks/1047.3688854d.js' = '42930:c8f6081a91e3e06684e91d36536fdfea592a12feb8155da904c6070f2aab94fa'
  'dist/client/chunks/1154.54d54566.js' = '64841:36948ae58503f35536c9faefb7c8a8eae76edfe5fc40230b6a85db86ef138f82'
  'dist/client/chunks/1274.65a3e0eb.js' = '20418:fde53d1238ed3a02c4b52c7cb337ae01741735ea8cf67a9a4dcb45b5ce1d265d'
  'dist/client/chunks/1383.97ee6e1b.js' = '62690:02781b86cf596b8bc793102366172097f33c3e7b3cab8ae3c439dcc67a3655c4'
  'dist/client/chunks/145.6888189f.js' = '34855:ad13f8462c835d473d0474a92d0ce987b285243de8e09b8601b2eaf9e754a590'
  'dist/client/chunks/1559.b1df2566.js' = '28677:c97ed3373c2b4107ac0348ce6a3e20bf8d54b8645e105f90379abfdc1f2d3a27'
  'dist/client/chunks/157.2867e3b4.js' = '12031:d4bbcea37f7f1fe8b389046034e3c2b2e91b7a9cdfd001784883e6859e77a3c5'
  'dist/client/chunks/1736.1cda46f3.js' = '36504:4caa4853b79908a3290b088e69c28f8eccaea171f9281a71960f4c4ade0a9506'
  'dist/client/chunks/2104.99046a63.js' = '70864:5ab54d03db53ed4168256992f8345a49a6f0ba5bff6944432d951f6174b6c4d6'
  'dist/client/chunks/2125.8df0165b.js' = '575941:50e3bac65199f80b4c6379d362358655309d5849f719c3afb423237490750791'
  'dist/client/chunks/2245.e6bb6fc5.js' = '10051:e698c5041663eb4e003445c329fc5d85145e543ef2b9f99e61bf9990017ad59a'
  'dist/client/chunks/2400.9d782298.js' = '17353:60dfab39dcd9fa03484f9e2224f45349ed471b2065a07129db1b32c34b17a40e'
  'dist/client/chunks/2653.ad352eaf.js' = '23479:f3b3e39a9bb2946d3d8350bedc241eb368ca034e19d853a6779c7d9434f7907f'
  'dist/client/chunks/2727.835f05af.js' = '9894:c17e9443db80ed42075b9b30e90804cb30ff577289462eb13adf19a6debc2a2d'
  'dist/client/chunks/3004.fb492e3d.js' = '70338:40b30a3d3a837862ce3ba00e6a82b66230cf9261abcf22cd57592ea6f36dac99'
  'dist/client/chunks/3108.bd704d07.js' = '58484:a0daeefa9eda1c3cabc667e4dca21a5aaddffdba5f7f14c9cd2ca9bab5cad980'
  'dist/client/chunks/3291.5726ee7a.js' = '78788:4679152c744762ed4165c1d598e92cfc6af6c989ff91c3756c8a9318182a4470'
  'dist/client/chunks/3358.39f9622d.js' = '25635:7de39d20733f2a3535548cb56921490d4578b83d42206be8fdc99d5c3a5128fa'
  'dist/client/chunks/3433.95eef682.js' = '59168:01b0237489d9585f486046bf8dd4f21baae172b4597d0e38131c7700a4321df0'
  'dist/client/chunks/3702.dbe5ec4f.js' = '35136:785e395e3d7df804e95856d7b1bdb9cb2e074c01cdc582951bb8928908f0b7da'
  'dist/client/chunks/4014.0399d15d.js' = '7457:df383c758d66a227bcb2abf62c369b556641b82055de8efa8e46b6991e5971ca'
  'dist/client/chunks/4154.efe1c636.js' = '323765:05a9d359fad0fab942bce8540f060b8896b71d5b8ef0953617a3bd29b6e25d4e'
  'dist/client/chunks/4177.10094582.js' = '86234:240c5f46e8e42f69f738e61d157d3ea8be6436531392a3dbf8e6d8ea01d7f65c'
  'dist/client/chunks/4263.383630de.js' = '148722:6fa2182374c5e0a92172f9cd56cf3ba454a3a4b6f0d1e844f8a6c0a1054902ee'
  'dist/client/chunks/4364.f7aefca0.js' = '21749:4e5854418ee96bf5d7ca111961268d42faa0ff8b20bfa3a5eb7fa737e5c6042e'
  'dist/client/chunks/4409.f810a4db.js' = '6645:0421a5858f8e7f7becbab036eccd1b3c490db69e1767764fcccf03080329cfc7'
  'dist/client/chunks/4413.bfede54e.js' = '313:8d8c7090447e6109fb1c84cfa71e3d294044bbf488abc96139de2c2df0450644'
  'dist/client/chunks/4445.d3a3caa4.js' = '15320:c0c92470190793fd123a278144e3415655b7cffd6f16c15057b1ce41c446acd9'
  'dist/client/chunks/4537.6d0fb835.js' = '108903:d52cb2de7e613ed72a8fbbc3f90023cb75c0561d2f27c52377656cddcb2f9a49'
  'dist/client/chunks/4565.d6b7ed9c.js' = '61795:84d83f3d4b5bbca436aad93443d34c9da625fa6872e9f0e2af6f8b50a05f8f3e'
  'dist/client/chunks/4570.e1017c0d.js' = '64386:33f031017aeeedcfe2a2cde7284e36cddf26f243c14313d28086254352c68567'
  'dist/client/chunks/4594.fea61ea6.js' = '8212:ecf623d1ba628b8c8de102cda2c6e36f082f7d36ac65ba8290dca34649fbc69a'
  'dist/client/chunks/4658.798ae254.js' = '19690:9cc5a6c6cedc54dbc56705c99c10c6a5427468cd1dd77734dc10b6d2eca86e9d'
  'dist/client/chunks/4687.004093b0.js' = '78330:391ff5d7a9b439b6894305f42817be1c80a3f971b8c944acca6bf3d86c30d3af'
  'dist/client/chunks/4831.6addcbfe.js' = '73124:b0dffff017d442ed0e0293c3907481be605fe6443cd354bb50d4c440ea7cae12'
  'dist/client/chunks/4987.5fb1df88.js' = '31449:ab0e7b3d0a0f5ed7304061e93de2428d747cc79dfc2bfb7746b671855948f9de'
  'dist/client/chunks/5031.01e20da3.js' = '87832:49dd90e4f87a8e21b45d38cedcd980348549c8fe464fff126f8128cc649fab8e'
  'dist/client/chunks/5084.1adedac4.js' = '36252:ac222c162a94e5b8f7f170ca3cdaafa289ce12fe26402ccab057781a68b2c4d2'
  'dist/client/chunks/5339.5cc8044f.js' = '253543:ee1da037db3eeb0ce3fb93e246207359c4428223064b4d3ba53bdb06c3232d90'
  'dist/client/chunks/5408.c79066e6.js' = '64104:b8dc1723c86e7af3a01a81daaa6f3adee1d3e9de0a7ccb2377d3370a8fb53534'
  'dist/client/chunks/5545.a82ef650.js' = '47693:8bcda4846766a81724797837ffbf2f0e9ac303408946ba3253062d61c83498a1'
  'dist/client/chunks/5737.4e344ddf.js' = '17620:b710ec7b82cc33693b279ddb12948e31aa3e69ce34c643777b45f9a38ea1cf53'
  'dist/client/chunks/5768.072a2a1e.js' = '2560:a3ae169e307ad51a8e176e44159db3fa57e9ae5b7348434e632dc099dc6dcd06'
  'dist/client/chunks/5817.f7575c50.js' = '35661:0f56d9c01af69caa73eb4d4ee82450a6fc169bb55e3919713cc480fbc6d2da2d'
  'dist/client/chunks/5933.22338337.js' = '15461:142388a0628ba4fa4c199bcefbac1cb9b67ff15f1188753a0561d55e4674e576'
  'dist/client/chunks/6109.5a5852ca.js' = '126308:504a33190db74d572152bae8bd1efb068c7e2132f3ab8689311484b2bf9a0cd7'
  'dist/client/chunks/6212.67ffabd9.js' = '27401:1250d48ac8d32f0302bf3856ac04f5d3991c28b3f1f6a028ed6b00c5cd8972c5'
  'dist/client/chunks/6313.0ec5ee0d.js' = '398530:fc7a1d94223d65dbe5e14883afa26e612c098ce7903b5fbd16c64155fd16e426'
  'dist/client/chunks/6375.100f9b97.js' = '112537:2d3edab5696a10b6a49b19acb3323f2a0372d87ff113c3541b116342e1786d40'
  'dist/client/chunks/6382.34ff138a.js' = '78488:0bb55cf7543c08526354855b182649b997da065ee63e9d1414186ef873c4fa54'
  'dist/client/chunks/6505.288e0518.js' = '10715:addb0e5923124ee9fa065332f8141a59ba61ff43a6e7232d8d35eae5e6952ee4'
  'dist/client/chunks/6514.c74a99ce.js' = '59912:2793442998b7e76d151b73b2a1930c963f3936294756fadd47eaabb143c78c62'
  'dist/client/chunks/6534.6f494754.js' = '58906:d2a672a035860a039d0e3f7cb99f5819ac540d6296c98b3f959edff9d95ff741'
  'dist/client/chunks/6551.2b4c5785.js' = '18538:39bd690ae4b9d402d3cb475fd5c485afa41416b155991dd5907c6e777bb098a3'
  'dist/client/chunks/6698.28f2fbe6.js' = '40700:a610a0429117629040e35eea4201afb4b9d36ed83dc12b04fd9fd2ced3934a1e'
  'dist/client/chunks/6735.10b80b59.js' = '58042:0b91aa00d97884aadbc03054b79a7a90863e2aea085e4de5e4e10272842f2df0'
  'dist/client/chunks/6769.c1bea668.js' = '11688:a48bcf3c513beb562a4accf28b7c1cf12348e985a643f4d4a5213efa3470664c'
  'dist/client/chunks/6921.7bceb715.js' = '58072:97b4264d614361802a99ed3307b77e08741ccdd57a9461b2b0868a1f238dcee1'
  'dist/client/chunks/6968.c7c6fa78.js' = '190:e3b796b5b6fd4074e42de83f95a2487fccf81f2b58e94524c210afde7344d1ad'
  'dist/client/chunks/7172.bca64508.js' = '35379:9ebbe62bafd8c7ae9706dec29d230da87e5e5e5eb34185d2b9ce4c4648e6ad8e'
  'dist/client/chunks/7449.b5926257.js' = '10619:0078a8abf3a715ac63f8f74f01b3bf246954798a39625272de5fa4444f7ba237'
  'dist/client/chunks/7994.9f5b3c44.js' = '19296:b0187c48e50c1fb3e5b2848779c9576b560c2b2a249d206092395293171db1fd'
  'dist/client/chunks/8118.9927356b.js' = '149860:35ff9d34b4c5aad9950733867a4e58ca30a3143df755cbbd0e840984143627de'
  'dist/client/chunks/8118.bb11944d.css' = '79077:a94899e13800f8c6b20f82da75e09ad9596a477f94779ce5294546c9f743a1d6'
  'dist/client/chunks/8118.bb11944d.legacy.css' = '78674:1adc5a2b4853c9ff71a1db6fe79c2347fcd85579c172aa7ed9464dff42339398'
  'dist/client/chunks/818.9ee7c1cf.js' = '85059:411b412b322aac7876a295dcce82c1e60e528f19b638765ca571730a2a17c57f'
  'dist/client/chunks/8685.433df22f.js' = '12357:a89280e45a5cb53f9421783ad589b98b2779ef6f9ce9404ffcb0595f12dfadda'
  'dist/client/chunks/8706.9c8963d5.js' = '11320:d38bdfff2bb227df25200d172c9a07f3458b48d785d6e00b040bac0a451d437c'
  'dist/client/chunks/8785.c4296f35.js' = '18560:6b33b7c4d2f6f8730dcfab699ea88cff42abfbcd647f018ce1dbed0e7ac078c7'
  'dist/client/chunks/8798.fd539220.js' = '50088:8b71fa3bc122472283e6a65c408984103b0501432add14d12f42aac6ff3fe1f9'
  'dist/client/chunks/8851.194fb4db.js' = '74529:15c50a978475cfd3acaa027d41df4ba12929c2ac76233f4ba019e9acf87cd333'
  'dist/client/chunks/8897.5df577cc.js' = '145842:312dfed3760458d51eaaf5e3693ee5cfc27779106e779468d1e36b86acf29182'
  'dist/client/chunks/8915.9dce38dc.js' = '23296:42730cf2fc0abf5f4b7604f5188f0633cd3282943572210da327692449b07e32'
  'dist/client/chunks/9025.5eb01656.js' = '54712:912cb3fe30406aa87ab296f36ff4856a270f7daa6113f3664f66f4a1b5bb801f'
  'dist/client/chunks/9078.dfd4282e.js' = '54152:29587dc5592bf6aab3b92a8bbd759ca53747f9c18ce25584e3e3d5de907e6306'
  'dist/client/chunks/9168.2e9815fa.js' = '203936:c8fdb593cec03d26e631bf454ea9c5c3510fdbf98fc65dba03bfb92efb00dbc9'
  'dist/client/chunks/959.d83f40dc.js' = '11433:4a008e1736fbcd943b1889775110789d3b2bfe366fe337d9a9c0aa41f9085347'
  'dist/client/chunks/9956.ddc41332.js' = '33559:836f180001eb0b295a7e51a10e9cdd4912a083d6ae5b2abd9acbbc2972511e2f'
  'dist/client/chunks/1081.00b41d86.js' = '36206:52a386d68bdce7bc3b1fb944c997fc5aa677558449f668c57b8694e2995892a0'
  'dist/client/chunks/115.e0fd8177.js' = '64846:d8cf297bd037432ac30ecd36a88e27ff5d233c6a9d4158a89445cae739bf65a0'
  'dist/client/chunks/1291.e05be733.js' = '210249:06f53dc409eee70761857931cb0e24791d2899d126dfeb5e521323d444651d5a'
  'dist/client/chunks/138.c56d3c72.js' = '30607:1162fef3496f2436ab8744f8e5ea0b3270a9c5880e5877dbf1816b8024a3db85'
  'dist/client/chunks/1414.b0be4604.js' = '34191:db6b8f141f1cc0bc68947ca2b2648d63ea43b8b8ef15eea9e58299609a520c72'
  'dist/client/chunks/1437.c086ef5f.js' = '17510:2e21fe883eb9801962d80f5328e858d2d0dc84eb6df6f1bf12ee023d2187a05b'
  'dist/client/chunks/1451.72615bca.js' = '38700:e0c4f722c7df33a9f8bc437fe9071142723dbdddd51b2bd9958a47859cf7fcb6'
  'dist/client/chunks/1482.82ce3b34.js' = '201542:1cb522f384b8324c69bca82f1e172cb54225f9ccea5d41542c784172593e63be'
  'dist/client/chunks/1495.f9cd9a6b.js' = '29428:2eef7f5dd02dc50b82c0b64e060098f3073fc45ad821f2b004f2814886491752'
  'dist/client/chunks/1510.1c283dec.js' = '61506:197cf80b263d8c0d2629b559bc44d4060eec2273c83e3638be242ffbed145066'
  'dist/client/chunks/1510.81420523.css' = '34974:7b9dca395f7832a793b0cc7a551e59bd016e1a2f58b1edf073649b8fa9455712'
  'dist/client/chunks/1510.81420523.legacy.css' = '34575:a0d441f478a1af05ac5a72b78aa4a375e8df2ed3f988eae211f448d33cea86fb'
  'dist/client/chunks/1523.b10e72f3.js' = '11324:3863f8ed6bda776b3a9a494e5df0422896eb4a0c721a96bbdfa3cd7caf2e17ee'
  'dist/client/chunks/1692.59b499a8.css' = '32508:4c5314b9eb6ba07effeb0181c3e8e1f0715bd88c0b3ef3724fdc9f4f74884053'
  'dist/client/chunks/1692.59b499a8.legacy.css' = '32129:5a62d1f55640d58cd9e943b2395c7cd3f50c05e747dda163cbe6ff25ab1b5b87'
  'dist/client/chunks/1692.67bfaf19.js' = '58080:60fc74c469478d6f130236f43532a69420c4bed9df6c48a342018e8b9fc13136'
  'dist/client/chunks/1876.4ebe7cbd.js' = '108932:89154b494c384cc9a38a38561c840708b464ed8080abd918d6195215673a57ae'
  'dist/client/chunks/2172.4c33f36d.js' = '6648:15098b27864ca47742f25b2b893123ecfdf35e6df5c1ca1162af77cd10972e9c'
  'dist/client/chunks/2177.fbcecc8e.js' = '52844:7c61c8fe773811755122f0458f289ba3e52ece0b81137365abb2a6e25b601980'
  'dist/client/chunks/2552.7bd112c3.js' = '78502:afae14872015eafad9f1e7250dc76c7d901fd6cb51a0a160075150c364af9291'
  'dist/client/chunks/2700.d2e9b5ae.js' = '33370:eda48c47b33c96ea116a1408559dda15aeace85697b5c9b7f6d7d2c8fe28427e'
  'dist/client/chunks/2983.e20096f5.js' = '15458:d6fa63e593ca55ef67380267b86ae354b7223576b7cae13044b26e949808a038'
  'dist/client/chunks/3057.2beb2565.js' = '11415:9c74752a227eadeda056713d9867b4bfedf909bfd7cab700a3c741cc81904272'
  'dist/client/chunks/3081.edaede7f.js' = '11773:22c40f87b03be93df7131a8277fb4e68785ca406df6ca0332a7a93671051051d'
  'dist/client/chunks/3177.7c05833c.js' = '78784:05258e60826917b9e8ac5211d5ced8a1da8798a0426b01d4d87de889994aedda'
  'dist/client/chunks/3197.76ef384a.js' = '21047:d27544ddba8a82422feebe38adc208baacfcc1028fb1509fd6dcd3edabf4f810'
  'dist/client/chunks/3220.970fb12d.js' = '23484:933ed0d6a5bbdc3704ac115681c58bab30a9da80c0f41e4cba14565ae73d6c49'
  'dist/client/chunks/3668.e1428848.js' = '398628:bfb34eb3389046cdb8ef578f3fd81a2d428982b6c47c2b14f77adc190dd50e10'
  'dist/client/chunks/3732.652375b4.js' = '8793:23d9fb5933118205b4edc0c84e8905600a3a9657b04538c45ed9cb1fb0407a34'
  'dist/client/chunks/3791.273af75e.js' = '21753:cf42eb2aafe1f8b90fa18b6c292f854a114c13b07f49b6d63855f5fce7cfc20f'
  'dist/client/chunks/3984.2e5bc9da.js' = '70335:75d0b1705001dae240acd23538dad1a013c8d9ebabde7fd4e32511576e7f90c8'
  'dist/client/chunks/4114.aa29ab4c.js' = '18568:2dabaebb4f6f16a14088a841bcea31bbe6e39bb19b173eea482f11976429b560'
  'dist/client/chunks/4190.5b96c360.js' = '35658:fe5ba6589055dce215f1e2d1793b8cc24f3d46fb364187cc07a9a0827459694b'
  'dist/client/chunks/4248.650ca48a.js' = '86232:9e4cf1c5a1f789659da92ce372c2d46c2778cf7ecc4cd7c815c0acda96a1621b'
  'dist/client/chunks/4330.e3139306.js' = '12032:b5ef4cd2ea07d88fdf0b7ba0544c7e40706a5da27f6552477f400afa81b8374e'
  'dist/client/chunks/44.0ec8a5f0.js' = '9885:162a08807a62af033d3900bf26e394d8fa7a5b4ea05f46c1a854c0de3d14dfaa'
  'dist/client/chunks/4463.40216300.js' = '62751:98236625ac1985d30fb562e4a4549aef7fe6d4e0e9ca2b95f386b1957a270a22'
  'dist/client/chunks/4576.f9c7d069.js' = '373954:b234f6e472ebd5bf39cf8d9d4239e06e9e2587d8a5e2fc337a7a4235dc290983'
  'dist/client/chunks/4585.b9d220d6.js' = '35310:815a10ccb7e72d29ddd7d507fcbc23abadda04d0f41c1d41119b06e9a0c5c11e'
  'dist/client/chunks/4681.0ea6c47b.js' = '75911:dd41436ac20249c28632f58459fcca655451c7d8b9ce42105954554afa39ee84'
  'dist/client/chunks/4791.6682a381.js' = '81445:1e22a1301cbf7745bbb12f92cc98283b217942b067577c51f3c506583054c20c'
  'dist/client/chunks/4791.695eb80d.css' = '37970:d8bd006b7ccd73ce75866b4262de9423136c8e8761e28dafbaa85cf25870dc03'
  'dist/client/chunks/4791.695eb80d.legacy.css' = '37581:1c753281d9823ea5aef91d2eab79e98493f3e997f2b223b27c9071ada29e0475'
  'dist/client/chunks/4994.b7c948f6.js' = '37013:95d35e2cbda559f598477ddc41bc189dc9f08410cfa62cc1d3134b079607ecce'
  'dist/client/chunks/528.2abc1a74.js' = '11637:3d5f5d99b690b95e0c3f067dba66f5f80f39bfbbcd4e152aae58997dad52a475'
  'dist/client/chunks/5312.c291ed5d.js' = '88487:fcb1aae4d451fed26f033805fe35c42709523ecbc90e6c2dd81f08d1be457505'
  'dist/client/chunks/5317.7409de20.js' = '27409:2bfe521ce89b5fbe3332823959c79bfd4cc0495406a8501975d6c9c1eda28bb8'
  'dist/client/chunks/5658.221c54f6.js' = '9889:406fe30cb0028163ee168b7634ea3e14e14d15a446c70ebaaf75a199d77b783c'
  'dist/client/chunks/5834.bb46f185.js' = '16732:d96cff5bad659ab0f6479c55448fa7a8a2332225fedd8ef37821e713f228f150'
  'dist/client/chunks/5902.eb0583f9.js' = '20559:fb0b82b90ac031261b1c5c56969ec1301e176cdd339839e910e34cd9d9de792b'
  'dist/client/chunks/5936.8a71b15e.js' = '62451:fb1c69f7725ac353823e82f2ff5d4d9b56b4338bfc790f243e38b23cbe55e13d'
  'dist/client/chunks/6052.609fb4e2.js' = '36513:d725f34c7ec47f1ecfca0a6b5768a23ee16d0473ce61d0ad060c81ed669a22bf'
  'dist/client/chunks/6058.3469ab0a.js' = '72982:f5e56265afa4ec6b17f88fa75d6b29d9b31ef2487fec93a59a9bdc37d5f9b5ef'
  'dist/client/chunks/6155.d8069817.js' = '50104:b5f026dee794db93bb21a9af21f70ec0bfc9bd150e971608c7db42c859698ee9'
  'dist/client/chunks/6161.582351c3.js' = '15406:b37033cab2a378ae5978a9e577994dbb141d3bf60e1f5b1e55c4d110baf330ec'
  'dist/client/chunks/6514.54166f2f.js' = '23233:2d524910841a0415b3ebd942060d09770e2ce3578ed959789a14affad8e4e4c8'
  'dist/client/chunks/6575.57bc6122.js' = '73864:8339da69b12b569bf6d18857e6aa40edd2051d210210c2f2ca7524c37d76af6c'
  'dist/client/chunks/6638.1aef3dc1.js' = '25124:7376324e22934c671648dd91eacb8c99361668c72b244ddfa298aeb34638f2aa'
  'dist/client/chunks/7051.1d73f00d.js' = '108324:6f334b69d2c5c02d06e2ee71480b8648306b7871a6ee4d3f10c75abee6058caa'
  'dist/client/chunks/709.598cfbf8.js' = '40644:1688c81aa8b5c8cba16958c71a526b52f32bbe3ac5afb490f663ca99d108ad16'
  'dist/client/chunks/7280.82d1cb85.js' = '20443:82d02cb333b04d429e9f4e1931c5cf8a2c90037b467c3831e12c46853df35bd5'
  'dist/client/chunks/7311.af8d5cdf.js' = '78332:70bed646c639d382b5a5d45bf8b54927591accd6ead721fd2888c2f0688cf99b'
  'dist/client/chunks/761.7b142717.css' = '30898:4b50624b1ccb150488de7f85898582b5f75bf095e3f410209ade01cdd2ff8eb2'
  'dist/client/chunks/761.7b142717.legacy.css' = '30733:f6f1a572d8648344f1d20e2eb704e2cb332bef5f6f64b090dc1d8dbe680ab554'
  'dist/client/chunks/761.bafe235d.js' = '52060:b5ffb01721cde07cfcb1e4ae0c1839e38b59310da8cf3089687eed20603229d8'
  'dist/client/chunks/7776.4fea9b53.css' = '53860:b0bf1125e7879fee3b5d898e88005f355ec7da7d3b6737c80df9cd5afa55c3b7'
  'dist/client/chunks/7776.4fea9b53.legacy.css' = '53424:52d69a6015374c1303611715e724bfef96ad5c0fcb689c244986a258ccc38175'
  'dist/client/chunks/7776.6c08d2d3.js' = '138707:f90987c277cf8356ce1cdbd873d689f12e8ac0e70ca58955756fd7d48e1e7e7d'
  'dist/client/chunks/7890.b18322f9.js' = '31454:a3c130a5b544f72e11b52fdebec1e42f902ebd95c49c75e9a47c58512fbcab82'
  'dist/client/chunks/8010.0058fb80.js' = '102645:b6f3d475200ac3677da8870399c3612aae4a9173c3ed58610c36f8dbbea47776'
  'dist/client/chunks/8615.ed66679b.js' = '176940:2249e0e26b7ae708504dd050fe9d56d2ca780633bc368948ef3bda0642f2c3b5'
  'dist/client/chunks/8797.4eaa8ef4.js' = '9379:47b53168b4d5f41ea9eb51844a7ea2a2d4227b7ae2d0e5a6fd9697a98b1f4515'
  'dist/client/chunks/8942.ce0d63ee.js' = '58065:a3eabe97cac6598352a9fdc2b4beda80c845811fbc85dc9fbcf8c518c17bd6b8'
  'dist/client/chunks/9197.0625c9d7.js' = '32439:6b329460cba2b781021fe254a765778049ac09a9705617b57b9c026cca6b2137'
  'dist/client/chunks/9203.4b5fc5b2.js' = '19445:318049d23fd8616d2c0e87b7daa3ecc87671a9f557c61b2d76f7f9b81e3abc39'
  'dist/client/chunks/9518.4df7a43f.js' = '7463:ecc34c299e2ee62fab229145a31d6457aa64b281ec6a3266491d54638d6c4d4d'
  'dist/client/chunks/9692.cf4d9d06.js' = '54712:673993f8e95ee726650b563dd061e25539817b7c217d642af19fa5463f1f0f37'
  'dist/client/chunks/9779.62bcdb4a.js' = '52246:19c75cf4ca7f43b3c5c6b4c4ae2f0a71a1028095fb293935d16ebbb0cda60d14'
  'dist/client/chunks/9791.48e63d2a.js' = '25788:445ca49b2b40bf12abd153ba487c62336da3c8542257bf45d096803148ab84ed'
  'dist/client/chunks/9932.4e9b405e.js' = '313:81007bcf029cc9c342933fe4f8f14e9f0e3aee26be5747d5bc6bf15d97c91f21'
  'dist/client/chunks/9993.1c93dccd.js' = '33550:3b465ddd504d56c8372dab3238c3b3547f9a6f267988f5569b6a901d18d97999'
  'dist/client/chunks/1081.0a07ac9c.js' = '36429:812563ec3acbc8310870dd28ae7f92a97bc43714cc9416d9a9044c07972642c0'
  'dist/client/chunks/115.724612d0.js' = '64846:44ed31ef83bd9adb41789d4f35d2fef29fb5a62b5fa3dadf40b5de094658e6f6'
  'dist/client/chunks/1291.9e178e69.js' = '204738:9bf5b3c91cacfc7215e1c3e5ba9fda647283fd976fb21600c941cc954919426b'
  'dist/client/chunks/138.f1b36382.js' = '30607:4d390b92619be446cc4045075c22e87cf55e415007baa66635755b9da2307eb5'
  'dist/client/chunks/1414.8da82243.js' = '34191:d9243a18a4f08e889d447d78358c9ebcff5b07fabb2c510445ab4afa540da74d'
  'dist/client/chunks/1451.ba7a4c40.js' = '38700:4366ff46584cba8a799d2db29198533388ef4da36e9508c27ec2e18195d0a4b3'
  'dist/client/chunks/1495.ee427b0f.js' = '29428:e0f39faaf3eec4ccff248ed18b440a4f9a5d4788df7a556cb87d451b820553a7'
  'dist/client/chunks/1510.08d8cb0d.js' = '61619:0b62a6f4eb84bf1390cecc2da3ed45eee35339a36cf11cdd346742cf19a0997f'
  'dist/client/chunks/1523.894d260f.js' = '11324:4bd4f6b8f31f3ad32ab868368bc09ed833c676b1475a400c4380e07d85108dc0'
  'dist/client/chunks/1692.c49178ca.js' = '58080:1edbf7479a7920f98a2e82bb808255965e51a46a13aa7f6b034cf3dc0e065be6'
  'dist/client/chunks/1876.b0506f77.js' = '108932:162b7e8bfa35f617e07606a11356b094f0fc541e1e52736f773ff98a8e0bb71d'
  'dist/client/chunks/2172.54e78099.js' = '6648:ac271069f44284b1151faa412111276937b43c52075a3a0c42241717eb2eb488'
  'dist/client/chunks/2552.ee420656.js' = '78502:b55a06a82b2a19790a0a43834631966712f3e9a3a78517d0e8e3e0ef62365b42'
  'dist/client/chunks/2700.5b4906bf.js' = '33370:8450bd5cac0f072bb00da267d6d57c88bc9cb321fb36bb19d0c63381edbe7031'
  'dist/client/chunks/2983.77ce0971.js' = '15458:17edcb28855ca26efd99940bed0c69fc7c848383a53dfc42ecb6bb4b746b3973'
  'dist/client/chunks/3034.2171320c.js' = '68295:f2ea16f61c68b8d912920e250a1df4220314eb27a248b0c0b64daca37cebd938'
  'dist/client/chunks/3081.5972088a.js' = '11773:e5803512524ef559059d91eb03d7fa1fefa558586c77e49f51ec6409fb25f6bb'
  'dist/client/chunks/3177.46f5ecd8.js' = '78784:8162bcf74b2c2a8082a2335a2230cf6b0a0a4bc60385490143b6fcde5bc877c4'
  'dist/client/chunks/3220.fca888e3.js' = '23484:27b02e05e50a1c2fd7cc2f8e817ca6d50d450f91dc1aee710c98084f7ae7a030'
  'dist/client/chunks/3668.c9f41805.js' = '398726:86a4184739b364b0f72216cb340612dcf37f6794198559ed85df9bbe540e92c2'
  'dist/client/chunks/3730.4872905c.js' = '212783:dad2d643741a7ac10de260c284bd64702205033218274a312e5c93451033bd27'
  'dist/client/chunks/3732.38bb855f.js' = '8793:7d0bfb25b52655621688ac90183cdd8f1c7cec2621f0be499f929714793e5bf8'
  'dist/client/chunks/3791.e3736612.js' = '21753:058c340a4b3e516ef6c0e7dd4c9da9a561d6930711aa07800fb06a6a845d5c25'
  'dist/client/chunks/3984.b54bebbf.js' = '70335:a885ddf65f5afc07b57f13e04f30e37f52e16b6301a1470e01bb8e5e63f8add7'
  'dist/client/chunks/4114.c7c11455.js' = '18568:f1e7170272d0af69d8f3187e98e3335af6d66cc2ef64a65502a0fd4c638f7d68'
  'dist/client/chunks/4190.3a28ceaf.js' = '35658:f73066ec1d7d49c8b9268087faeb052fc50c8d2d6b15034eca21bee3ea9468ae'
  'dist/client/chunks/4248.05301f84.js' = '86232:cf593a67ce71af2252d160a2e32e71c6463e77565d646808ffbf2d00e311c9a6'
  'dist/client/chunks/4330.e069c3d9.js' = '12032:e720dcdd558e763f835266a3f4acb8f239cc7eeb87bfdbc5c1deac31f7a2c5a7'
  'dist/client/chunks/44.dce6d6e8.js' = '9885:688d032683b41b0b6b56e8dcb2fc938a888770ad3d094e495bd13ef2c9f7f924'
  'dist/client/chunks/4463.55330bd9.js' = '62751:2583efe7dffd2b23bb1685c545a6aab55e3a837c3f03fc76aeb49d2a8be46506'
  'dist/client/chunks/4576.a2ce5dd7.js' = '242516:6d7c31e25ce60c914a65de87a8ad4855b1123a0fa795cdaea56852300f962e96'
  'dist/client/chunks/4585.2747a130.js' = '35310:ac6cf075080a1c5fcb844074be95f54842efbeba256a92cf042628481c8cde04'
  'dist/client/chunks/4681.ffdc8fa9.js' = '75911:f4f97489968608f5fffd159d762bd72d5b907e4bc0f14a61fca287c26082e2ee'
  'dist/client/chunks/4791.49df5b21.js' = '81445:e1029ef72fcc746c17bfbc907935bc38b02bd88eb3663d7bd2399cfdd8c97622'
  'dist/client/chunks/4994.9eaa8ee2.js' = '37013:baec97a65f2bb8c995e0c0f6d1e251bb94b6be37e01d31079f870184e22d053e'
  'dist/client/chunks/528.bc4d5bb6.js' = '11637:3e3f68023edcabef3c1d9c59dc66b502e47a6f2ded9c82dafca7709d2c17a655'
  'dist/client/chunks/5312.406e20d0.js' = '88487:440ae949675c8072dcd9600d714c5c9542fa25974cd50aa3f4e0b735f1ce6650'
  'dist/client/chunks/5317.7d81aa9f.js' = '27522:5b76b7997c253180b0f2eb05f284d900384fe390e4f55e4cf75edbf27cb6e14c'
  'dist/client/chunks/5386.a17de440.js' = '20139:df4ef417a36a6a188d08933a91878164047a3d45a2c3980edc27efd8aaf661d7'
  'dist/client/chunks/5666.f7661969.js' = '74167:6cb786307537c0c45eac295c08725f9b5643a6bbf4f048ec9ae04c156f15e492'
  'dist/client/chunks/5834.a9e38903.js' = '16732:fb39187fe044ec6303bfa1328826a4317b14fd3160c41e3b060c39eca437179b'
  'dist/client/chunks/5902.bbef4282.js' = '20559:329bbafbe5b286d7942c11e90930f5b661b827a56d4b57aa9e353489655ecdae'
  'dist/client/chunks/5936.605c0561.js' = '62451:de7ec9034dbc8aa3965ca753c52aa1a81d945ecd8eb743f300594bf48408cbe8'
  'dist/client/chunks/6052.d7a0d8e0.js' = '36513:22f3b29c216532d1e377bba8ab0dd8300de6e3b5e7223d696c555829423b80c3'
  'dist/client/chunks/6058.602adbf7.js' = '72982:b9de198ad7fec7e2c4a07881d8a7d3f1181e2f3f83c17ec58834cac4f7598ce2'
  'dist/client/chunks/6155.e0550fab.js' = '50104:68897bd127d6a5f781bd10ec4e1591ea5ba252742d84cd235dfe549b35081557'
  'dist/client/chunks/6161.c4dddf96.js' = '15406:e813e28e374bd660125c4d51c382ac0f814ed2dd80163f842c0854ea81c90496'
  'dist/client/chunks/6514.dca40086.js' = '23233:334ac3e3816067de2c4b31b3b4717e7f477d1d530f1ae749df653121af7720dc'
  'dist/client/chunks/6638.ef9e7889.js' = '25124:f7c4b5e30838ff75fe8a8174bc6cb1fb0c45203651dc9a3881fc9d7fd9812aa6'
  'dist/client/chunks/6730.b31010b2.js' = '10002:247d6e9aa8c18e1b9cedd9c5bffc41126b1591cbf43d490156136c525e96ded4'
  'dist/client/chunks/7051.8f76c147.js' = '108324:b8550fd5c07aa56ab4204d82d1d7e17fa327635734b16ab7bd8fa410a9a80ce9'
  'dist/client/chunks/709.de2aebd7.js' = '34851:be10ead6952b1b320e09064c11c301bcf17f4c4a9076530d5d52d9921a8619bc'
  'dist/client/chunks/7311.cb2f3b55.js' = '78332:8a2d1e7b3d3e68222110c852418e40efe5cc148d5f503459f0a905da7afd6a9e'
  'dist/client/chunks/761.86a92854.js' = '52477:b3f4787d10979d613bd59d90166efe684bfffddbbf9169a8f43ede1c5d093614'
  'dist/client/chunks/7776.776bfa35.css' = '50055:2b2751f74bea60766faeedcc8930c7caf9df885ae8a782b6deb8bc405c629206'
  'dist/client/chunks/7776.776bfa35.legacy.css' = '49619:cd26c858f155d4d6a2180f608b2c94c53ad371ef068e91a815a79cad39fc694f'
  'dist/client/chunks/7776.9ee9fd40.js' = '127986:7bc7e4e6ec702001806e752016fcad4771aa2e6d8aa38b60b2a7c58d2cfa15af'
  'dist/client/chunks/7890.8a5193c1.js' = '31454:c96892d7b9e8392316f07428ac9260005883a8ad5f8345520a629cf05214b9a3'
  'dist/client/chunks/8010.3e41c50a.js' = '102645:292246c449c34125352a30b4e03a721d07552c425ccb198ad8454d0cfdae5580'
  'dist/client/chunks/8277.f8dcaedb.js' = '17231:0d2d49a45231ff7693282bb642c9d6292e5724888fd404e90197392e48415e06'
  'dist/client/chunks/8615.cd2a9fb7.js' = '133380:29cd5f72c63a3e8260d106f4169107f648903f2cd1e0e0557b22aa8eb7712fd9'
  'dist/client/chunks/8797.1438e4d2.js' = '9379:e5b4ee29ffb09b9a8cdf6be57c3ea7d41dad1a64f94c791e5ee7d0bdb10c4735'
  'dist/client/chunks/8942.761365fa.js' = '58065:d1973829403759a4e9a78c6976e096a35da97086fb47ffa67e6bec15f121dcc7'
  'dist/client/chunks/9197.1080110d.js' = '32439:654d925d3c933b8edee290fa4d39d24092fffd837d4529805dbc8fa909f9cf43'
  'dist/client/chunks/9203.51ff6ff5.js' = '19445:ec2199d5ec2c0b68b3fd9528fdf28768c95be3da082b76ebc7641dd7e2e694b2'
  'dist/client/chunks/9518.c39a98d0.js' = '7463:ab4c08755345691e282670d95494efb1f9e21f9550d225efa957824339169789'
  'dist/client/chunks/9692.9a47a3ec.js' = '54712:69111d210dda61801a46a025b4b887108d6ffac400ddd723c7708b456ccdcc27'
  'dist/client/chunks/9779.630ad6fb.js' = '52246:bf03fd250ed0bf4807cf177fb7119f775d6acc02eb5c84e38562cf168fd4e3eb'
  'dist/client/chunks/9791.b3386e48.js' = '25788:2ce39efb98747010a59a7f95df76345916f26e0d128142e262c292cf8db5ca2a'
  'dist/client/chunks/9932.f0ad718e.js' = '313:e0cf474761ef281f264e9b0377eeabc8423c2589c1e17c7a929b4ca54eff727e'
  'dist/client/chunks/9993.eeb88b4b.js' = '33550:6f59bc01203475f979bd1113779d5a40824804e783c9a3e8002b2a607e2f0d9e'
  'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.d.ts' = '586:37843a6a536f235475bf4a2c7731ad035f1060e6b2b385d4c6c4e4b94d4b154c'
  'dist/server/modules/bitable-sync/certificate-dashboard.scheduler.js' = '3262:b66b29d4d560585a8ead21d6fe3303432f1e54d9f08f546872d298faa2d01f08'
  'dist/server/modules/contract-management/contract-admin-auth.service.d.ts' = '1149:cab3da8d03a4e574e040680d32f6da02f04397aa29b7ee5173348785f13a6b86'
  'dist/server/modules/contract-management/contract-admin-auth.service.js' = '7075:24bafff7d9337b9d86da4c3cea5310d79a81560c391e6aae9b222295d07d84ee'
  'dist/server/modules/duty-schedule/duty-schedule.controller.ts' = '4141:4e7780d08883907818311aa7a03485164d3fe11de1506cc4c8d59502a32853ca'
  'dist/server/modules/duty-schedule/duty-schedule.service.ts' = '64733:770f13a760d8350c02f98141370171997c5b75f5708da302d51ba68b3c1107ab'
  'dist/server/modules/duty-schedule/duty-staff-actual-fill.d.ts' = '265:67a58fe46ae21a1aaac2b61b156088cb664af36d5a9417513dc2461b86b2622f'
  'dist/server/modules/duty-schedule/duty-staff-actual-fill.js' = '1618:11c878c8c1a9e13edf0c5b842ba73a163c0efcafc303a8de5b4e441749026d9f'
  'dist/server/modules/purchase-inventory/purchase-application-auth.service.d.ts' = '1162:93817e4080d8ab831fde20bfb4f8de4e6de25393e0bd5b8eed472d012e889372'
  'dist/server/modules/purchase-inventory/purchase-application-auth.service.js' = '7885:c0e585343f5b69aff5784eb4b2caef7a15e07a691fe871fd68eb3161159c005e'
  'dist/server/modules/purchase-inventory/purchase-record-admin-auth.d.ts' = '280:f020e3bdefbc55e7ca71054a6df985390c0cbb550b203eab72be25abf1471009'
  'dist/server/modules/purchase-inventory/purchase-record-admin-auth.js' = '1508:e347c2f461affbc858c87ec509b6309486a38c402afaf1157d255eaaf8a2fa4a'
  'dist/shared/api.interface.ts' = '7509:a19cea32a85c9b4ef187351d69e6a7cf93f8cc1d6ebbc073c1de0b3a05f2fd93'
  'dist/shared/monthly-schedule-access.d.ts' = '232:404577975facd7dcb9476a55632055290df3e9c8eda199cb854782467e73751d'
  'dist/shared/monthly-schedule-access.js' = '365:6780bce41fed141a68e2a1ee30deb09b25cab72945169f76d849f61397490b08'
}

$knownHistoricalReleaseTargetProofs = @{
  'scripts/migrate-dingtalk-attendance-credentials.ps1' = '4296:01181545b5e4ec33f0b8d7152dd12933d3ba241a7517e64464ed0cd633e36d9d'
}
$script:clientGenerationPolicyLogged = $false

function Test-KnownObsoleteRuntimeArtifact {
  param(
    [string]$RelativePath,
    [System.IO.FileInfo]$File
  )

  $exactPaths = @(
    $knownObsoleteRuntimeArtifactProofs.Keys |
      Where-Object { [string]$_ -ceq $RelativePath }
  )
  if ($exactPaths.Count -ne 1) {
    return $false
  }
  $proofParts = ([string]$knownObsoleteRuntimeArtifactProofs[$exactPaths[0]]).Split(':')
  [int64]$expectedSize = 0
  if (
    $proofParts.Count -ne 2 -or
    -not [int64]::TryParse(
      $proofParts[0],
      [System.Globalization.NumberStyles]::None,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [ref]$expectedSize
    ) -or
    $proofParts[1] -cnotmatch '^[0-9a-f]{64}$'
  ) {
    throw "Known obsolete runtime artifact proof is invalid: $RelativePath"
  }
  if ([int64]$File.Length -ne $expectedSize) {
    return $false
  }
  $actualHash = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  return $actualHash -ceq $proofParts[1]
}

function Throw-UnexpectedRuntimeFiles {
  param(
    [System.Collections.Generic.List[string]]$RelativePaths,
    [string]$SingularPrefix,
    [string]$PluralPrefix
  )

  if ($RelativePaths.Count -eq 0) {
    return
  }
  $sortedPaths = @($RelativePaths | Sort-Object { Get-PathSortKey -Path ([string]$_) })
  if ($sortedPaths.Count -eq 1) {
    throw "$SingularPrefix$($sortedPaths[0]). No files were changed."
  }
  throw "$PluralPrefix$($sortedPaths.Count)):`n - $($sortedPaths -join "`n - ")`nNo files were changed."
}

function Assert-ServerRuntimeBaseline {
  param(
    [string]$Root,
    [object]$Manifest
  )
  $exportSchemaVersion = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineExportSchemaVersion') `
    -Name 'baselineExportSchemaVersion'
  $exportType = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineExportType')
  $planAlgorithm = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineExportPlanAlgorithm')
  $planFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineExportPlanFingerprint')
  $baselineFingerprint = [string](Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineFingerprint')
  $distFingerprints = Get-RequiredObjectPropertyValue -Object $Manifest -Name 'distFingerprints'
  $serverBaselineFiles = @(
    Get-RequiredObjectPropertyValue -Object $Manifest -Name 'serverBaselineFiles'
  )
  $expectedBaselineFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineFileCount') `
    -Name 'baselineFileCount'
  $expectedPayloadFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselinePayloadFileCount') `
    -Name 'baselinePayloadFileCount'
  $expectedMetadataFileCount = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineMetadataOnlyFileCount') `
    -Name 'baselineMetadataOnlyFileCount'
  $expectedPayloadBytes = Get-NonNegativeInt64ManifestValue `
    -Value (Get-RequiredObjectPropertyValue -Object $Manifest -Name 'baselineUncompressedBytes') `
    -Name 'baselineUncompressedBytes'
  if (
    $exportSchemaVersion -ne 3 -or
    $exportType -cne 'server-hotfix-baseline-read-only' -or
    $planAlgorithm -cne 'webpack-main-runtime-map-v1' -or
    $planFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
    $baselineFingerprint -cnotmatch '^[0-9a-f]{64}$' -or
    $serverBaselineFiles.Count -eq 0
  ) {
    throw 'Hotfix manifest is missing the complete server baseline.'
  }
  foreach ($runtimeRoot in @('dist/server', 'dist/shared', 'dist/client')) {
    $distFingerprintProperty = @(
      $distFingerprints.PSObject.Properties |
        Where-Object { $_.Name -ceq $runtimeRoot }
    )
    if (
      $distFingerprintProperty.Count -ne 1 -or
      [string]$distFingerprintProperty[0].Value -cnotmatch '^[0-9a-f]{64}$'
    ) {
      throw "Hotfix manifest contains an invalid server baseline dist fingerprint: $runtimeRoot"
    }
  }
  $verifiedEntries = New-Object System.Collections.Generic.List[object]
  $expectedRuntimePaths = @{}
  $allBaselinePaths = @{}
  $payloadFileCount = [int64]0
  $metadataFileCount = [int64]0
  $payloadBytes = [int64]0
  $knownObsoleteRuntimeArtifactCount = 0
  $unexpectedRuntimePaths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($entry in $serverBaselineFiles) {
    $relativePath = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'path')
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    if ($allBaselinePaths.ContainsKey($relativePath)) {
      throw "Duplicate server baseline manifest path: $relativePath. No files were changed."
    }
    $allBaselinePaths[$relativePath] = $true
    $entryReason = Get-ServerBaselineEntryReason -Entry $entry
    Assert-ServerBaselineEntryReasonPath -RelativePath $relativePath -Reason $entryReason
    $entryHash = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'sha256')
    $entrySize = Get-NonNegativeInt64ManifestValue `
      -Value (Get-RequiredObjectPropertyValue -Object $entry -Name 'size') `
      -Name "serverBaselineFiles.size:$relativePath"
    if ($entryHash -cnotmatch '^[0-9a-f]{64}$') {
      throw "Server baseline runtime entry contains an invalid hash or size: $relativePath. No files were changed."
    }
    $actualSize = $entrySize
    $actualHash = $entryHash
    $verifyLiveEntry = (
      $null -eq $entryReason -or
      -not $relativePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)
    )
    if ($verifyLiveEntry) {
      $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $relativePath
      Assert-PathHasNoReparsePointAncestors -Path $fullPath
      Assert-FinalPathContainedByRoot -Root $Root -Path $fullPath
      Assert-NoAlternateDataStreamsAtPath -Path $fullPath
      if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Server baseline runtime file is missing: $relativePath. No files were changed."
      }
      $actualSize = (Get-Item -LiteralPath $fullPath).Length
      $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualSize -ne $entrySize -or $actualHash -cne $entryHash) {
        throw "Server baseline runtime file mismatch: $relativePath. No files were changed."
      }
    }
    if ($null -eq $entryReason) {
      $payloadFileCount += 1
      $payloadBytes += $actualSize
    } else {
      $metadataFileCount += 1
    }
    $verifiedEntry = [ordered]@{
      path = $relativePath
      size = $actualSize
      sha256 = $actualHash
    }
    if ($null -ne $entryReason) {
      $verifiedEntry['reason'] = $entryReason
    }
    [void]$verifiedEntries.Add($verifiedEntry)
    if (
      $verifyLiveEntry -and
      (
        $relativePath.StartsWith('dist/server/', [System.StringComparison]::OrdinalIgnoreCase) -or
        $relativePath.StartsWith('dist/shared/', [System.StringComparison]::OrdinalIgnoreCase) -or
        $relativePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)
      )
    ) {
      $expectedRuntimePaths[$relativePath] = $true
    }
  }
  if (
    $expectedBaselineFileCount -ne $serverBaselineFiles.Count -or
    $expectedPayloadFileCount -ne $payloadFileCount -or
    $expectedMetadataFileCount -ne $metadataFileCount -or
    $expectedBaselineFileCount -ne ($payloadFileCount + $metadataFileCount) -or
    $expectedPayloadBytes -ne $payloadBytes
  ) {
    throw 'Hotfix manifest server baseline counts or bytes mismatch. No files were changed.'
  }

  foreach ($runtimeRoot in @('dist/server', 'dist/shared', 'dist/client')) {
    $runtimePath = Resolve-AppRootTargetPath -Root $Root -RelativePath $runtimeRoot
    if ($runtimeRoot -ceq 'dist/client') {
      if (-not $script:clientGenerationPolicyLogged) {
        Write-Host '[INFO] Previous client generations will be replaced as one directory; only the active client closure is validated.'
        $script:clientGenerationPolicyLogged = $true
      }
    } else {
      foreach ($file in @(Get-ChildItem -LiteralPath $runtimePath -File -Force -Recurse)) {
        $relativePath = Get-RelativeUnixPath -BasePath $Root -FullPath $file.FullName
        if (-not $expectedRuntimePaths.ContainsKey($relativePath)) {
          if (Test-KnownObsoleteRuntimeArtifact -RelativePath $relativePath -File $file) {
            $knownObsoleteRuntimeArtifactCount += 1
            continue
          }
          [void]$unexpectedRuntimePaths.Add($relativePath)
        }
      }
    }
    $runtimePrefix = $runtimeRoot + '/'
    $runtimeMaterial = @(
      $verifiedEntries |
        Where-Object { $_.path.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase) } |
        Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
        ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
    ) -join "`n"
    $expectedProperty = @($distFingerprints.PSObject.Properties | Where-Object { $_.Name -ceq $runtimeRoot })
    if ($expectedProperty.Count -ne 1 -or (Get-TextSha256 -Text $runtimeMaterial) -cne [string]$expectedProperty[0].Value) {
      throw "Server baseline dist fingerprint mismatch: $runtimeRoot. No files were changed."
    }
  }

  Throw-UnexpectedRuntimeFiles `
    -RelativePaths $unexpectedRuntimePaths `
    -SingularPrefix 'Unexpected server baseline runtime file: ' `
    -PluralPrefix 'Unexpected server baseline runtime files ('
  if ($knownObsoleteRuntimeArtifactCount -gt 0) {
    Write-Host "[INFO] Accepted $knownObsoleteRuntimeArtifactCount hash-proven obsolete runtime artifact(s) for atomic cleanup."
  }

  $fingerprintMaterial = @(
    $verifiedEntries |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object { "$($_.path):$($_.size):$($_.sha256)" }
  ) -join "`n"
  if ((Get-TextSha256 -Text $fingerprintMaterial) -cne $baselineFingerprint) {
    throw 'Server baseline fingerprint mismatch. No files were changed.'
  }
  $exportPlanMaterial = @(
    $verifiedEntries |
      Sort-Object { Get-PathSortKey -Path ([string]$_.path) } |
      ForEach-Object {
        $hasReason = $_ -is [System.Collections.IDictionary] -and $_.Contains('reason')
        if ($hasReason) {
          "metadata`0$([string]$_.reason)`0$($_.path)`0$($_.size)`0$($_.sha256)"
        } else {
          "payload`0$($_.path)`0$($_.size)`0$($_.sha256)"
        }
      }
  ) -join "`n"
  if ((Get-TextSha256 -Text $exportPlanMaterial) -cne $planFingerprint) {
    throw 'Server baseline export-plan fingerprint mismatch. No files were changed.'
  }
}

function Assert-ServerDistBaseline {
  param(
    [string]$Root,
    [object]$Manifest,
    [AllowNull()]
    [string]$DistRoot,
    [switch]$AllowReplaceableClientDrift
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $distRootPath = if ([string]::IsNullOrWhiteSpace($DistRoot)) {
    [System.IO.Path]::GetFullPath((Join-Path $rootPath 'dist'))
  } else {
    [System.IO.Path]::GetFullPath($DistRoot)
  }
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $distRootPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The previous dist proof root is outside the application root.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $distRootPath
  Assert-FinalPathContainedByRoot -Root $rootPath -Path $distRootPath
  $distEntries = @(
    @(Get-RequiredObjectPropertyValue -Object $Manifest -Name 'serverBaselineFiles') |
      Where-Object {
        ([string]$_.path).StartsWith('dist/', [System.StringComparison]::OrdinalIgnoreCase)
      }
  )
  if ($distEntries.Count -eq 0) {
    throw 'The hotfix transaction cannot prove the previous dist runtime.'
  }
  if ($AllowReplaceableClientDrift) {
    $clientRoot = Join-Path $distRootPath 'client'
    Assert-PathHasNoReparsePointAncestors -Path $clientRoot
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $clientRoot
    if (-not (Test-Path -LiteralPath $clientRoot -PathType Container)) {
      throw 'The replaceable previous client runtime directory is missing.'
    }
    Assert-NoReparsePoints -Root $clientRoot
    $clientFiles = @(Get-ChildItem -LiteralPath $clientRoot -File -Force -Recurse)
    if ($clientFiles.Count -eq 0) {
      throw 'The replaceable previous client runtime is empty.'
    }
    $clientAnchorPaths = @(
      (Join-Path $clientRoot 'index.html'),
      (Join-Path $clientRoot 'main.js')
    )
    $clientAnchors = @($clientAnchorPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($clientAnchors.Count -eq 0) {
      throw 'The replaceable previous client runtime has no recognized entry file.'
    }
    foreach ($clientAnchor in $clientAnchors) {
      Assert-NoAlternateDataStreamsAtPath -Path $clientAnchor
    }
    Write-Host '[INFO] Treating the proven historical frontend as one replaceable directory; server and shared runtime hashes remain strict.'
  }
  $expectedPaths = @{}
  $allDistPaths = @{}
  $knownObsoleteRuntimeArtifactCount = 0
  $unexpectedRuntimePaths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($entry in $distEntries) {
    $relativePath = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'path')
    [void](Assert-CanonicalRelativePath -RelativePath $relativePath)
    if ($allDistPaths.ContainsKey($relativePath)) {
      throw "Duplicate previous dist runtime path: $relativePath"
    }
    $allDistPaths[$relativePath] = $true
    $expectedSize = Get-NonNegativeInt64ManifestValue `
      -Value (Get-RequiredObjectPropertyValue -Object $entry -Name 'size') `
      -Name "serverBaselineFiles.size:$relativePath"
    $expectedHash = [string](Get-RequiredObjectPropertyValue -Object $entry -Name 'sha256')
    if ($expectedHash -cnotmatch '^[0-9a-f]{64}$') {
      throw "The previous dist runtime has an invalid manifest hash: $relativePath"
    }
    $entryReason = Get-ServerBaselineEntryReason -Entry $entry
    if (
      $null -ne $entryReason -and
      $relativePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      continue
    }
    if (
      $AllowReplaceableClientDrift -and
      $relativePath.StartsWith('dist/client/', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      continue
    }
    $expectedPaths[$relativePath] = $true
    $distRelativePath = $relativePath.Substring('dist/'.Length)
    $fullPath = [System.IO.Path]::GetFullPath((
      Join-Path $distRootPath $distRelativePath.Replace('/', '\')
    ))
    if (-not $fullPath.StartsWith(
      $distRootPath.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "The previous dist runtime path escapes its proof root: $relativePath"
    }
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "The previous dist runtime file is missing: $relativePath"
    }
    $actualSize = (Get-Item -LiteralPath $fullPath -Force).Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne $expectedSize -or $actualHash -cne $expectedHash) {
      throw "The previous dist runtime file does not match its baseline: $relativePath"
    }
  }
  foreach ($runtimeRoot in @('dist/server', 'dist/shared', 'dist/client')) {
    $runtimeRelativePath = $runtimeRoot.Substring('dist/'.Length)
    $runtimePath = [System.IO.Path]::GetFullPath((
      Join-Path $distRootPath $runtimeRelativePath.Replace('/', '\')
    ))
    Assert-PathHasNoReparsePointAncestors -Path $runtimePath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $runtimePath
    if ($runtimeRoot -ceq 'dist/client') {
      continue
    }
    Assert-NoReparsePoints -Root $runtimePath
    foreach ($file in @(Get-ChildItem -LiteralPath $runtimePath -File -Force -Recurse)) {
      $relativePath = 'dist/' + (Get-RelativeUnixPath -BasePath $distRootPath -FullPath $file.FullName)
      if (-not $expectedPaths.ContainsKey($relativePath)) {
        if (Test-KnownObsoleteRuntimeArtifact -RelativePath $relativePath -File $file) {
          $knownObsoleteRuntimeArtifactCount += 1
          continue
        }
        [void]$unexpectedRuntimePaths.Add($relativePath)
      }
    }
  }
  Throw-UnexpectedRuntimeFiles `
    -RelativePaths $unexpectedRuntimePaths `
    -SingularPrefix 'Unexpected file in the previous dist runtime: ' `
    -PluralPrefix 'Unexpected files in the previous dist runtime ('
  if ($knownObsoleteRuntimeArtifactCount -gt 0) {
    Write-Host "[INFO] Accepted $knownObsoleteRuntimeArtifactCount hash-proven obsolete runtime artifact(s) while proving the previous runtime."
  }
}

function Assert-InstalledReleaseReceiptDist {
  param(
    [string]$Root,
    [object]$Receipt,
    [AllowNull()]
    [string]$DistRoot
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $distRootPath = if ([string]::IsNullOrWhiteSpace($DistRoot)) {
    [System.IO.Path]::GetFullPath((Join-Path $rootPath 'dist'))
  } else {
    [System.IO.Path]::GetFullPath($DistRoot)
  }
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $distRootPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installed-release runtime proof root is outside the application root.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $distRootPath
  Assert-FinalPathContainedByRoot -Root $rootPath -Path $distRootPath
  $expectedPaths = @{}
  foreach ($entry in @($Receipt.runtimeFiles)) {
    $relativePath = [string]$entry.path
    $expectedPaths[$relativePath] = $true
    $distRelativePath = $relativePath.Substring('dist/'.Length)
    $fullPath = [System.IO.Path]::GetFullPath((
      Join-Path $distRootPath $distRelativePath.Replace('/', '\')
    ))
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "The installed-release runtime file is missing: $relativePath"
    }
    $actualSize = (Get-Item -LiteralPath $fullPath -Force).Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne [int64]$entry.size -or $actualHash -cne [string]$entry.sha256) {
      throw "The installed-release runtime file does not match its receipt: $relativePath"
    }
  }
  foreach ($runtimeRoot in @('dist/server', 'dist/shared')) {
    $runtimeRelativePath = $runtimeRoot.Substring('dist/'.Length)
    $runtimePath = [System.IO.Path]::GetFullPath((
      Join-Path $distRootPath $runtimeRelativePath.Replace('/', '\')
    ))
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Container)) {
      throw "The installed-release runtime directory is missing: $runtimeRoot"
    }
    Assert-NoReparsePoints -Root $runtimePath
    foreach ($file in @(Get-ChildItem -LiteralPath $runtimePath -File -Force -Recurse)) {
      $relativePath = 'dist/' + (Get-RelativeUnixPath -BasePath $distRootPath -FullPath $file.FullName)
      if (-not $expectedPaths.ContainsKey($relativePath)) {
        throw "Unexpected file outside the installed-release receipt: $relativePath"
      }
    }
  }
  $clientRoot = Join-Path $distRootPath 'client'
  if (-not (Test-Path -LiteralPath $clientRoot -PathType Container)) {
    throw 'The installed-release client runtime directory is missing.'
  }
  Assert-NoReparsePoints -Root $clientRoot
  $receiptClientEntries = if ([int]$Receipt.schemaVersion -eq 1) {
    @($Receipt.clientEntryFiles)
  } else {
    @($Receipt.activeClientFiles)
  }
  foreach ($entry in $receiptClientEntries) {
    $distRelativePath = ([string]$entry.path).Substring('dist/'.Length)
    $fullPath = [System.IO.Path]::GetFullPath((
      Join-Path $distRootPath $distRelativePath.Replace('/', '\')
    ))
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "The installed-release active client file is missing: $([string]$entry.path)"
    }
    $actualSize = (Get-Item -LiteralPath $fullPath -Force).Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne [int64]$entry.size -or $actualHash -cne [string]$entry.sha256) {
      throw "The installed-release active client file does not match its receipt: $([string]$entry.path)"
    }
  }
}

function Assert-InstalledReleaseReceiptReleaseFiles {
  param(
    [string]$Root,
    [object]$Receipt
  )
  foreach ($entry in @($Receipt.releaseFiles)) {
    $relativePath = [string]$entry.targetPath
    $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $relativePath
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-FinalPathContainedByRoot -Root $Root -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "The installed-release root file is missing: $relativePath"
    }
    $actualSize = (Get-Item -LiteralPath $fullPath -Force).Length
    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSize -ne [int64]$entry.size -or $actualHash -cne [string]$entry.sha256) {
      throw "The installed-release root file does not match its receipt: $relativePath"
    }
  }
}

function Assert-InstalledReleaseReceiptState {
  param(
    [string]$Root,
    [object]$Receipt
  )
  Assert-InstalledReleaseReceiptDist -Root $Root -Receipt $Receipt
  Assert-InstalledReleaseReceiptReleaseFiles -Root $Root -Receipt $Receipt
}

function Assert-PreviousDistRuntime {
  param(
    [string]$Root,
    [object]$Manifest,
    [AllowNull()]
    [string]$DistRoot
  )
  if ($script:installedReleaseReceiptActive) {
    Assert-InstalledReleaseReceiptDist `
      -Root $Root `
      -Receipt $script:installedReleaseReceipt `
      -DistRoot $DistRoot
    return
  }
  $receiptProofError = $null
  if (
    $null -ne $script:installedReleaseReceipt -and
    [int]$script:installedReleaseReceipt.schemaVersion -eq 2
  ) {
    try {
      Assert-InstalledReleaseReceiptDist `
        -Root $Root `
        -Receipt $script:installedReleaseReceipt `
        -DistRoot $DistRoot
      $script:priorInstalledReleaseReceiptRuntimeProofActive = $true
      if (-not $script:priorInstalledReleaseReceiptRuntimeProofLogged) {
        Write-Host '[INFO] Used the strict prior installed-release receipt to prove the interrupted rollback runtime; current release-tool and dependency compatibility remain independently enforced.'
        $script:priorInstalledReleaseReceiptRuntimeProofLogged = $true
      }
      return
    } catch {
      $receiptProofError = $_.Exception.Message
    }
  }
  try {
    Assert-ServerDistBaseline `
      -Root $Root `
      -Manifest $Manifest `
      -DistRoot $DistRoot `
      -AllowReplaceableClientDrift
  } catch {
    if ($receiptProofError) {
      throw "Neither the strict prior installed-release receipt nor the explicit server baseline proves the previous runtime. Receipt proof failed: $receiptProofError Explicit baseline proof failed: $($_.Exception.Message)"
    }
    throw
  }
}

function Get-ManagedReleaseBaselineSnapshot {
  param(
    [string]$Root,
    [object]$Manifest
  )

  $managedTargets = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $targetPath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
    if ($managedTargets.ContainsKey($targetPath)) {
      throw "The current package manifest contains a duplicate release target: $targetPath"
    }
    $managedTargets[$targetPath] = $true
  }
  return @(
    foreach ($entry in @($Manifest.releaseFiles)) {
      $targetPath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
      $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $targetPath
      Assert-PathHasNoReparsePointAncestors -Path $fullPath
      Assert-FinalPathContainedByRoot -Root $Root -Path $fullPath
      $present = Test-Path -LiteralPath $fullPath
      if ($present -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "A managed release-root target is not a regular file: $targetPath"
      }
      if ($present) {
        $item = Get-Item -LiteralPath $fullPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "A managed release-root target is a reparse point: $targetPath"
        }
        Assert-NoAlternateDataStreamsAtPath -Path $fullPath
      }
      [pscustomobject][ordered]@{
        targetPath = $targetPath
        baselineExisted = $present
        baselineSha256 = if ($present) {
          (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else {
          ''
        }
      }
    }
  )
}

function Assert-ServerNonDistBaseline {
  param(
    [string]$Root,
    [object]$Manifest,
    [object[]]$ReleaseBaselineOverrides = @()
  )

  $releaseBaselineOverrideMap = Get-ReleaseBaselineOverrideMap `
    -ReleaseBaselineOverrides $ReleaseBaselineOverrides
  $managedReleaseTargets = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $managedReleaseTargets[(Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath))] = $true
  }
  foreach ($overrideTarget in @($releaseBaselineOverrideMap.Keys)) {
    if (-not $managedReleaseTargets.ContainsKey([string]$overrideTarget)) {
      throw "A release baseline snapshot contains an unmanaged target: $overrideTarget"
    }
  }

  foreach ($requiredPath in @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd', 'node_modules')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $requiredPath))) {
      throw "Required server baseline path is missing: $requiredPath. No files were changed."
    }
  }

  $actualBaseEntries = @(
    foreach ($entry in @($Manifest.baseFiles)) {
      $relativePath = [string]$entry.path
      $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $relativePath
      if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Server baseline fingerprint file is missing: $relativePath. No files were changed."
      }
      $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $expectedHash = if ($releaseBaselineOverrideMap.ContainsKey($relativePath)) {
        $override = $releaseBaselineOverrideMap[$relativePath]
        if (-not [bool]$override.baselineExisted) {
          throw "Server baseline fingerprint file was absent from its captured release state: $relativePath. No files were changed."
        }
        [string]$override.baselineSha256
      } else {
        [string]$entry.sha256
      }
      if ($actualHash -cne $expectedHash) {
        throw "Server baseline fingerprint mismatch: $relativePath. No files were changed."
      }
      "$relativePath`:$actualHash"
    }
  )
  $actualBaseFingerprint = Get-TextSha256 -Text ($actualBaseEntries -join "`n")
  if (
    $releaseBaselineOverrideMap.Count -eq 0 -and
    $actualBaseFingerprint -cne [string]$Manifest.baseFingerprint
  ) {
    throw 'Server baseFingerprint mismatch. No files were changed.'
  }

  foreach ($entry in @($Manifest.releaseFiles)) {
    $targetRelativePath = [string]$entry.targetPath
    $targetPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $targetRelativePath
    $baseline = if ($releaseBaselineOverrideMap.ContainsKey($targetRelativePath)) {
      $releaseBaselineOverrideMap[$targetRelativePath]
    } else {
      $entry
    }
    $targetPresent = Test-Path -LiteralPath $targetPath
    $targetExists = Test-Path -LiteralPath $targetPath -PathType Leaf
    if ($targetPresent -and -not $targetExists) {
      throw "Server baseline release target is not a file: $($entry.targetPath). No files were changed."
    }
    if (-not [bool]$baseline.baselineExisted -and $targetPresent) {
      if ($releaseBaselineOverrideMap.ContainsKey($targetRelativePath)) {
        throw "Server baseline contains a release target absent from its captured state: $targetRelativePath. No files were changed."
      }
      $actualExistingReleaseSize = (Get-Item -LiteralPath $targetPath -Force).Length
      $actualExistingReleaseHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $matchesCandidateRelease = (
        $actualExistingReleaseSize -eq [int64]$entry.size -and
        $actualExistingReleaseHash -ceq [string]$entry.sha256
      )
      $historicalProofPaths = @(
        $knownHistoricalReleaseTargetProofs.Keys |
          Where-Object { [string]$_ -ceq [string]$entry.targetPath }
      )
      $matchesHistoricalRelease = $false
      if ($historicalProofPaths.Count -eq 1) {
        $historicalProofParts = ([string]$knownHistoricalReleaseTargetProofs[$historicalProofPaths[0]]).Split(':')
        $matchesHistoricalRelease = (
          $historicalProofParts.Count -eq 2 -and
          $actualExistingReleaseSize -eq [int64]$historicalProofParts[0] -and
          $actualExistingReleaseHash -ceq [string]$historicalProofParts[1]
        )
      }
      if (-not $matchesCandidateRelease -and -not $matchesHistoricalRelease) {
        throw "Server baseline contains an unexpected release target: $($entry.targetPath). No files were changed."
      }
      if ($matchesHistoricalRelease) {
        Write-Host "[INFO] Upgrading hash-proven historical release target: $($entry.targetPath)"
      } else {
        Write-Host "[INFO] Reusing already-deployed hash-proven release target: $($entry.targetPath)"
      }
    }
    if ([bool]$baseline.baselineExisted -and -not $targetExists) {
      throw "Server baseline release target is missing: $($entry.targetPath). No files were changed."
    }
    if ([bool]$baseline.baselineExisted) {
      $actualBaselineHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualBaselineHash -cne [string]$baseline.baselineSha256) {
        throw "Server baseline release target hash mismatch: $($entry.targetPath). No files were changed."
      }
    }
  }
}

function Assert-ServerMutableBaseline {
  param(
    [string]$Root,
    [object]$Manifest,
    [switch]$AllowReplaceableClientDrift,
    [object[]]$ReleaseBaselineOverrides = @()
  )

  if (
    $script:installedReleaseReceiptActive -or
    $script:priorInstalledReleaseReceiptRuntimeProofActive
  ) {
    Assert-InstalledReleaseReceiptDist `
      -Root $Root `
      -Receipt $script:installedReleaseReceipt
  } elseif ($AllowReplaceableClientDrift) {
    Assert-ServerDistBaseline `
      -Root $Root `
      -Manifest $Manifest `
      -AllowReplaceableClientDrift
  } else {
    Assert-ServerRuntimeBaseline -Root $Root -Manifest $Manifest
  }
  Assert-ServerNonDistBaseline `
    -Root $Root `
    -Manifest $Manifest `
    -ReleaseBaselineOverrides $ReleaseBaselineOverrides
}

function Adopt-InstalledReleaseReceiptBaseline {
  param(
    [string]$Root,
    [object]$Manifest
  )
  if (-not $script:installedReleaseReceiptActive -or $null -eq $script:installedReleaseReceipt) {
    throw 'No compatible installed-release receipt is available for adoption.'
  }
  Assert-InstalledReleaseReceiptState `
    -Root $Root `
    -Receipt $script:installedReleaseReceipt
  $receiptReleaseOverrides = @(
    Get-InstalledReceiptReleaseBaselineOverrides `
      -Receipt $script:installedReleaseReceipt `
      -Manifest $Manifest
  )
  Assert-ServerNonDistBaseline `
    -Root $Root `
    -Manifest $Manifest `
    -ReleaseBaselineOverrides $receiptReleaseOverrides
  $script:adoptedReleaseBaselineOverrides = @(
    Get-ManagedReleaseBaselineSnapshot -Root $Root -Manifest $Manifest
  )
  $script:reusablePreviousRuntimeBaselineProof = $true
  $script:replaceableClientBaselineProof = $true
  $script:installedReleaseReceiptProven = $true
  Write-Host "[INFO] Adopted installed-release receipt for deployment $([string]$script:installedReleaseReceipt.deploymentId); no new server baseline export is required."
}

function Assert-RuntimeDirectoryRenameReady {
  param([string]$Root)
  $distPath = Join-Path $Root 'dist'
  $directory = Get-Item -LiteralPath $distPath -Force -ErrorAction Stop
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Runtime directory rename preflight requires an ordinary dist directory.'
  }
  try {
    [NantongHotfixNativeMethods]::AssertDirectoryRenameAccess($distPath)
  } catch {
    throw "Runtime directory rename preflight failed before downtime; the current service was not stopped. Release the directory handle or resolve its access permissions, then retry. Native detail: $($_.Exception.GetBaseException().Message)"
  }
}

function Move-ItemWithRetry {
  param(
    [string]$LiteralPath,
    [string]$Destination,
    [int]$Attempts = 30,
    [int]$DelayMilliseconds = 500
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
      Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq $Attempts) {
        throw
      }
      Start-Sleep -Milliseconds $DelayMilliseconds
    }
  }
}

function Open-LifecycleLock {
  param([string]$Root)

  $lifecycleLockPath = Join-Path $Root '.app-lifecycle.lock'
  try {
    return [System.IO.File]::Open(
      $lifecycleLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    throw 'Another application lifecycle operation is already running. No files were changed.'
  }
}

function Switch-ReleaseFiles {
  param(
    [string]$Root,
    [string]$StagedRoot,
    [string]$BackupRoot,
    [object]$Manifest,
    [object]$Transaction,
    [System.Collections.Generic.List[object]]$State,
    [object[]]$IntegrityHandles
  )
  $transactionBaselineMap = Get-ReleaseBaselineOverrideMap `
    -ReleaseBaselineOverrides (Get-TransactionReleaseBaselineOverrides -Transaction $Transaction)
  foreach ($entry in @($Manifest.releaseFiles)) {
    $targetRelativePath = ([string]$entry.targetPath).Replace('\', '/')
    $targetPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $targetRelativePath
    $stagedPath = Resolve-AppRootTargetPath -Root $StagedRoot -RelativePath $targetRelativePath
    $backupPath = Resolve-AppRootTargetPath -Root $BackupRoot -RelativePath $targetRelativePath
    if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf)) {
      throw "Staged release file is missing: $targetRelativePath"
    }

    $targetParent = Split-Path -Parent $targetPath
    $backupParent = Split-Path -Parent $backupPath
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    $hadOriginal = Test-Path -LiteralPath $targetPath -PathType Leaf
    if (-not $transactionBaselineMap.ContainsKey($targetRelativePath)) {
      throw "The durable transaction does not cover a managed release target: $targetRelativePath"
    }
    $transactionBaseline = $transactionBaselineMap[$targetRelativePath]
    if ($hadOriginal -ne [bool]$transactionBaseline.baselineExisted) {
      throw "A managed release target changed after its durable snapshot was recorded: $targetRelativePath"
    }
    if (
      $hadOriginal -and
      -not (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$transactionBaseline.baselineSha256))
    ) {
      throw "A managed release target hash changed after its durable snapshot was recorded: $targetRelativePath"
    }
    if ($hadOriginal) {
      Move-ItemWithRetry -LiteralPath $targetPath -Destination $backupPath
    }
    [void]$State.Add([pscustomobject]@{
      targetPath = $targetPath
      backupPath = $backupPath
      relativePath = $targetRelativePath
      hadOriginal = $hadOriginal
    })
    Write-HeldIntegrityFile `
      -IntegrityHandles $IntegrityHandles `
      -RelativePath ('release-root/' + $targetRelativePath) `
      -Destination $targetPath
  }
}

function Convert-CommandLineToArgv {
  param([string]$CommandLine)

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return @()
  }
  $argumentCount = 0
  $argumentPointer = [NantongHotfixNativeMethods]::CommandLineToArgvW(
    $CommandLine,
    [ref]$argumentCount
  )
  if ($argumentPointer -eq [IntPtr]::Zero) {
    throw 'The application process command line could not be parsed safely.'
  }
  try {
    $arguments = @(
      for ($index = 0; $index -lt $argumentCount; $index += 1) {
        $itemPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
          $argumentPointer,
          $index * [IntPtr]::Size
        )
        [Runtime.InteropServices.Marshal]::PtrToStringUni($itemPointer)
      }
    )
    return $arguments
  } finally {
    [void][NantongHotfixNativeMethods]::LocalFree($argumentPointer)
  }
}

function Test-CommandLineHasExpectedEntryPoint {
  param(
    [string]$CommandLine,
    [string]$ExpectedPath,
    [switch]$AllowLegacyRelativeEntryPoint
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($ExpectedPath)) {
    return $false
  }
  $arguments = @(Convert-CommandLineToArgv -CommandLine $CommandLine)
  if ($arguments.Count -lt 2) {
    return $false
  }
  $entryPoint = [string]$arguments[1]
  if (-not [System.IO.Path]::IsPathRooted($entryPoint)) {
    if (-not $AllowLegacyRelativeEntryPoint) {
      return $false
    }
    $normalizedLegacyEntryPoint = $entryPoint.Replace('\', '/')
    return [string]::Equals(
      $normalizedLegacyEntryPoint,
      'dist/server/main.js',
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  return [string]::Equals(
    [System.IO.Path]::GetFullPath($entryPoint),
    [System.IO.Path]::GetFullPath($ExpectedPath),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Get-ValidatedNodeProcess {
  param(
    [int]$ProcessId,
    [string]$ExpectedMainPath,
    [AllowNull()]
    [object]$ExpectedStartTimeUtc,
    [AllowNull()]
    [object]$NotBeforeUtc,
    [switch]$AllowLegacyRelativeEntryPoint
  )

  $runtimeProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  $runtimeExecutablePath = if ($runtimeProcess) { [string]$runtimeProcess.Path } else { '' }
  $cimExecutablePath = if ($processInfo) { [string]$processInfo.ExecutablePath } else { '' }
  if (
    -not $runtimeProcess -or
    $runtimeProcess.ProcessName -cne 'node' -or
    -not $processInfo -or
    [string]$processInfo.Name -cne 'node.exe' -or
    [string]::IsNullOrWhiteSpace($runtimeExecutablePath) -or
    [string]::IsNullOrWhiteSpace($cimExecutablePath) -or
    -not [string]::Equals(
      [System.IO.Path]::GetFullPath($runtimeExecutablePath),
      [System.IO.Path]::GetFullPath($cimExecutablePath),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    [System.IO.Path]::GetFileName($cimExecutablePath) -cne 'node.exe' -or
    -not (Test-CommandLineHasExpectedEntryPoint `
      -CommandLine ([string]$processInfo.CommandLine) `
      -ExpectedPath $ExpectedMainPath `
      -AllowLegacyRelativeEntryPoint:$AllowLegacyRelativeEntryPoint)
  ) {
    throw 'The app.pid owner cannot be proven to be this application Node process. No files were changed.'
  }

  $actualStartUtc = $runtimeProcess.StartTime.ToUniversalTime()
  if ($null -ne $ExpectedStartTimeUtc) {
    $startTimeDelta = [Math]::Abs(($actualStartUtc - ([DateTime]$ExpectedStartTimeUtc).ToUniversalTime()).TotalMilliseconds)
    if ($startTimeDelta -ge 1000) {
      throw 'The app.pid PID now belongs to a different process. No files were changed.'
    }
  }
  if ($null -ne $NotBeforeUtc -and $actualStartUtc -lt ([DateTime]$NotBeforeUtc).ToUniversalTime().AddSeconds(-1)) {
    throw 'The replacement app.pid points to a process that predates this launch. No files were changed.'
  }
  return [pscustomobject][ordered]@{
    ProcessId = [int]$processInfo.ProcessId
    StartTimeUtc = $actualStartUtc.ToString('o')
    ExecutablePath = [System.IO.Path]::GetFullPath($cimExecutablePath)
    MainFile = [System.IO.Path]::GetFullPath($ExpectedMainPath)
    AllowLegacyRelativeEntryPoint = [bool]$AllowLegacyRelativeEntryPoint
  }
}

function Confirm-ValidatedNodeProcessIdentity {
  param([object]$ValidatedProcess)

  $confirmed = Get-ValidatedNodeProcess `
    -ProcessId ([int]$ValidatedProcess.ProcessId) `
    -ExpectedMainPath ([string]$ValidatedProcess.MainFile) `
    -ExpectedStartTimeUtc ([DateTime]::Parse(
      [string]$ValidatedProcess.StartTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    )) `
    -NotBeforeUtc $null `
    -AllowLegacyRelativeEntryPoint:([bool]$ValidatedProcess.AllowLegacyRelativeEntryPoint)
  if (-not [string]::Equals(
    [string]$confirmed.ExecutablePath,
    [string]$ValidatedProcess.ExecutablePath,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'The app.pid PID executable changed before termination. No files were changed.'
  }
  return $confirmed
}

function Get-VerifiedPidFileProcess {
  param(
    [string]$Root,
    [switch]$RequireJsonRecord,
    [AllowNull()]
    [object]$NotBeforeUtc
  )

  $pidPath = Join-Path $Root 'app.pid'
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    if ($RequireJsonRecord) {
      throw 'The production app.pid record was not created. No files were changed.'
    }
    return $null
  }

  $expectedRootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $expectedMainPath = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist\server\main.js'))
  $pidText = ([System.IO.File]::ReadAllText(
    $pidPath,
    [System.Text.UTF8Encoding]::new($false)
  )).Trim()
  if ($pidText -match '^\d+$') {
    if ($RequireJsonRecord) {
      throw 'The replacement launcher wrote an unsafe legacy app.pid record. No files were changed.'
    }
    $processId = [int]$pidText
    if ($processId -le 0) {
      throw 'The legacy app.pid record is invalid. No files were changed.'
    }
    $process = Get-ValidatedNodeProcess `
      -ProcessId $processId `
      -ExpectedMainPath $expectedMainPath `
      -ExpectedStartTimeUtc $null `
      -NotBeforeUtc $NotBeforeUtc `
      -AllowLegacyRelativeEntryPoint
    $runtimeProcess = Get-Process -Id $processId -ErrorAction Stop
    $pidFileWriteUtc = (Get-Item -LiteralPath $pidPath).LastWriteTimeUtc
    $legacyWriteDelta = ($pidFileWriteUtc - $runtimeProcess.StartTime.ToUniversalTime()).TotalSeconds
    if ($legacyWriteDelta -lt -1 -or $legacyWriteDelta -gt 10) {
      throw 'The legacy app.pid timestamp cannot prove process ownership. No files were changed.'
    }
    return $process
  }

  try {
    $record = $pidText | ConvertFrom-Json -ErrorAction Stop
    Assert-ExactObjectProperties `
      -Object $record `
      -ExpectedNames @('schemaVersion', 'pid', 'startTime', 'appRoot', 'mainFile') `
      -Context 'The app.pid record'
    if ([int]$record.schemaVersion -ne 1) {
      throw 'unsupported schema'
    }
    $processId = [int]$record.pid
    $recordedRootPath = [System.IO.Path]::GetFullPath([string]$record.appRoot).TrimEnd('\')
    $recordedMainPath = [System.IO.Path]::GetFullPath([string]$record.mainFile)
    if (
      $processId -le 0 -or
      -not [string]::Equals($recordedRootPath, $expectedRootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($recordedMainPath, $expectedMainPath, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      throw 'path mismatch'
    }
    $recordedStartTime = [DateTime]::Parse(
      [string]$record.startTime,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    )
  } catch {
    throw "The app.pid record is invalid or belongs to another deployment: $($_.Exception.Message) No files were changed."
  }

  return Get-ValidatedNodeProcess `
    -ProcessId $processId `
    -ExpectedMainPath $expectedMainPath `
    -ExpectedStartTimeUtc $recordedStartTime `
    -NotBeforeUtc $NotBeforeUtc
}

function Get-AppProcesses {
  param(
    [string]$Root,
    [switch]$RequireRunning,
    [switch]$RequireJsonRecord,
    [AllowNull()]
    [object]$NotBeforeUtc
  )

  $pidPath = Join-Path $Root 'app.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $verifiedPidProcess = Get-VerifiedPidFileProcess `
      -Root $Root `
      -RequireJsonRecord:$RequireJsonRecord `
      -NotBeforeUtc $NotBeforeUtc
    return @($verifiedPidProcess)
  }
  if ($RequireJsonRecord) {
    throw 'The production app.pid record was not created. No files were changed.'
  }

  $expectedMainPath = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist\server\main.js'))
  $processes = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        Test-CommandLineHasExpectedEntryPoint `
          -CommandLine ([string]$_.CommandLine) `
          -ExpectedPath $expectedMainPath
      } |
      ForEach-Object {
        Get-ValidatedNodeProcess `
          -ProcessId ([int]$_.ProcessId) `
          -ExpectedMainPath $expectedMainPath `
          -ExpectedStartTimeUtc $null `
          -NotBeforeUtc $NotBeforeUtc
      }
  )
  if ($processes.Count -gt 1) {
    throw 'Multiple application Node processes match the exact main file. No files were changed.'
  }
  if ($RequireRunning -and $processes.Count -ne 1) {
    throw 'The current application Node process cannot be proven. No files were changed.'
  }
  return @($processes | ForEach-Object { $_ })
}

function Get-TrustedHotfixNodeExecutable {
  param([string]$Root)

  $candidates = New-Object 'System.Collections.Generic.List[string]'
  $cachedNodeVariable = Get-Variable `
    -Name 'trustedHotfixNodeExecutablePath' `
    -Scope Script `
    -ErrorAction SilentlyContinue
  if (
    $cachedNodeVariable -and
    -not [string]::IsNullOrWhiteSpace([string]$cachedNodeVariable.Value)
  ) {
    [void]$candidates.Add([string]$cachedNodeVariable.Value)
  }
  foreach ($process in @(Get-AppProcesses -Root $Root)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      [void]$candidates.Add([string]$process.ExecutablePath)
    }
  }
  $portableNodePath = Join-Path $Root '.runtime\node\node.exe'
  if (Test-Path -LiteralPath $portableNodePath -PathType Leaf) {
    [void]$candidates.Add($portableNodePath)
  }
  $commandNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($commandNode -and -not [string]::IsNullOrWhiteSpace([string]$commandNode.Source)) {
    [void]$candidates.Add([string]$commandNode.Source)
  }

  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    $fullPath = [System.IO.Path]::GetFullPath($candidate)
    if (
      [System.IO.Path]::GetFileName($fullPath) -cne 'node.exe' -or
      -not (Test-Path -LiteralPath $fullPath -PathType Leaf)
    ) {
      continue
    }
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    $nodeItem = Get-Item -LiteralPath $fullPath -Force
    if (($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      continue
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $fullPath
    if (
      $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate -or
      [string]$signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=OpenJS Foundation(,|$)'
    ) {
      continue
    }
    $versionOutput = @(& $fullPath --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -ne 1) {
      continue
    }
    $versionText = ([string]$versionOutput[0]).Trim()
    $parsedVersion = $null
    if ($versionText -notmatch '^v(?<version>\d+\.\d+\.\d+)$' -or -not [Version]::TryParse($Matches.version, [ref]$parsedVersion)) {
      continue
    }
    if ($parsedVersion.Major -lt 22) {
      continue
    }
    $script:trustedHotfixNodeExecutablePath = $fullPath
    return $fullPath
  }
  throw 'No trusted OpenJS Node.js 22+ executable is available for the hotfix proof gates.'
}

function Invoke-CandidateStartupConfigurationPreflight {
  param(
    [string]$Root,
    [string]$StageReleaseRoot
  )

  $preflightScript = [System.IO.Path]::GetFullPath(
    (Join-Path $StageReleaseRoot 'scripts\ensure-purchase-inventory-config.mjs')
  )
  if (-not (Test-Path -LiteralPath $preflightScript -PathType Leaf)) {
    return
  }
  Assert-PathHasNoReparsePointAncestors -Path $preflightScript
  Assert-FinalPathContainedByRoot -Root $StageReleaseRoot -Path $preflightScript
  Assert-NoAlternateDataStreamsAtPath -Path $preflightScript

  $nodePath = Get-TrustedHotfixNodeExecutable -Root $Root
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $preflightOutput = @(
      & $nodePath $preflightScript --root $Root --activate-workflow 2>&1
    )
    $preflightExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in $preflightOutput) {
    $text = ([string]$line).TrimEnd()
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      Write-Host $text
    }
  }
  if ($preflightExitCode -ne 0) {
    throw 'Candidate startup configuration preflight failed before downtime.'
  }
  Write-Host '[INFO] Candidate startup configuration preflight passed before downtime.'
}

function Assert-DependencyProofMatchesManifest {
  param(
    [object]$Report,
    [object]$Manifest
  )
  if (
    $null -eq $Report -or
    [bool](Get-RequiredObjectPropertyValue -Object $Report -Name 'success') -ne $true -or
    [bool](Get-RequiredObjectPropertyValue -Object $Report -Name 'physicalVerified') -ne $true -or
    [bool](Get-RequiredObjectPropertyValue -Object $Report -Name 'requiresNodeModulesMutation') -ne $false -or
    [string](Get-RequiredObjectPropertyValue -Object $Report -Name 'proofAlgorithm') -cne [string]$Manifest.dependencyProofAlgorithm -or
    [string](Get-RequiredObjectPropertyValue -Object $Report -Name 'lockPhysicalTreeFingerprint') -cne [string]$Manifest.dependencyLockPhysicalTreeFingerprint -or
    [string](Get-RequiredObjectPropertyValue -Object $Report -Name 'installedPhysicalTreeFingerprint') -cne [string]$Manifest.dependencyInstalledPhysicalTreeFingerprint -or
    [int](Get-RequiredObjectPropertyValue -Object $Report -Name 'packageCount') -ne [int]$Manifest.dependencyPackageCount -or
    [int](Get-RequiredObjectPropertyValue -Object $Report -Name 'fileCount') -ne [int]$Manifest.dependencyFileCount -or
    [int64](Get-RequiredObjectPropertyValue -Object $Report -Name 'bytes') -ne [int64]$Manifest.dependencyBytes
  ) {
    throw 'The installed production dependency tree does not match the hotfix manifest proof.'
  }
}

function Get-InstalledDependencyQuickState {
  param(
    [string]$Root,
    [string]$CandidateRoot,
    [string]$InstalledNodeModules,
    [string]$VerifierPath,
    [string]$NodePath,
    [object]$Manifest
  )

  $nodeModulesRoot = (Resolve-Path -LiteralPath $InstalledNodeModules -ErrorAction Stop).Path
  Assert-PathHasNoReparsePointAncestors -Path $nodeModulesRoot
  Assert-FinalPathContainedByRoot -Root $Root -Path $nodeModulesRoot
  $rootItem = Get-Item -LiteralPath $nodeModulesRoot -Force -ErrorAction Stop
  if (
    -not $rootItem.PSIsContainer -or
    ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw 'The installed production dependency root is unsafe for quick proof reuse.'
  }

  $material = New-Object 'System.Collections.Generic.List[string]'
  [void]$material.Add("root-final`0$([NantongHotfixNativeMethods]::GetFinalPath($nodeModulesRoot))")
  [void]$material.Add("root-identity`0$([NantongHotfixNativeMethods]::GetFileIdentity($nodeModulesRoot))")
  [void]$material.Add("root-created`0$($rootItem.CreationTimeUtc.Ticks)")
  [void]$material.Add("root-written`0$($rootItem.LastWriteTimeUtc.Ticks)")
  [void]$material.Add("proof`0$([string]$Manifest.dependencyProofAlgorithm)`0$([string]$Manifest.dependencyInstalledPhysicalTreeFingerprint)`0$([int]$Manifest.dependencyPackageCount)`0$([int]$Manifest.dependencyFileCount)`0$([int64]$Manifest.dependencyBytes)")

  $baselinePackagePath = Join-Path $Root 'package.json'
  $baselineLockPath = Join-Path $Root 'package-lock.json'
  $candidatePackagePath = Join-Path $CandidateRoot 'package.json'
  $candidateLockPath = Join-Path $CandidateRoot 'package-lock.json'
  $metadataHashes = [ordered]@{
    baselinePackageSha256 = (Get-FileHash -LiteralPath $baselinePackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    baselineLockSha256 = (Get-FileHash -LiteralPath $baselineLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
    candidatePackageSha256 = (Get-FileHash -LiteralPath $candidatePackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    candidateLockSha256 = (Get-FileHash -LiteralPath $candidateLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
    verifierSha256 = (Get-FileHash -LiteralPath $VerifierPath -Algorithm SHA256).Hash.ToLowerInvariant()
    nodeSha256 = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if (
    [string]$metadataHashes.candidatePackageSha256 -cne [string]$Manifest.candidatePackageSha256 -or
    [string]$metadataHashes.candidateLockSha256 -cne [string]$Manifest.candidatePackageLockSha256 -or
    [string]$metadataHashes.verifierSha256 -cne [string]$Manifest.dependencyVerifierSha256
  ) {
    throw 'The dependency quick proof inputs do not match the hotfix manifest.'
  }

  foreach ($inputPath in @(
    $VerifierPath,
    $NodePath,
    (Join-Path $nodeModulesRoot '.package-lock.json')
  )) {
    $fullPath = [System.IO.Path]::GetFullPath($inputPath)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      [void]$material.Add("file-absent`0$fullPath")
      continue
    }
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    [void]$material.Add("file`0$fullPath`0$($item.Length)`0$((Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant())")
  }

  $packageRoots = New-Object 'System.Collections.Generic.List[object]'
  foreach ($entry in @(Get-ChildItem -LiteralPath $nodeModulesRoot -Force -ErrorAction Stop)) {
    if (-not $entry.PSIsContainer -or $entry.Name -ceq '.bin') {
      continue
    }
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "The dependency quick proof found a reparse point: $($entry.FullName)"
    }
    [void]$packageRoots.Add($entry)
    if ($entry.Name.StartsWith('@', [System.StringComparison]::Ordinal)) {
      foreach ($scopedEntry in @(Get-ChildItem -LiteralPath $entry.FullName -Force -ErrorAction Stop)) {
        if (-not $scopedEntry.PSIsContainer) {
          continue
        }
        if (($scopedEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "The dependency quick proof found a reparse point: $($scopedEntry.FullName)"
        }
        [void]$packageRoots.Add($scopedEntry)
      }
    }
  }

  foreach ($packageRoot in @($packageRoots | Sort-Object FullName)) {
    Assert-PathHasNoReparsePointAncestors -Path $packageRoot.FullName
    $relativePath = $packageRoot.FullName.Substring($nodeModulesRoot.Length).TrimStart('\').Replace('\', '/')
    [void]$material.Add("directory`0$relativePath`0$([NantongHotfixNativeMethods]::GetFileIdentity($packageRoot.FullName))`0$($packageRoot.CreationTimeUtc.Ticks)`0$($packageRoot.LastWriteTimeUtc.Ticks)")
    $packageJsonPath = Join-Path $packageRoot.FullName 'package.json'
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
      Assert-NoAlternateDataStreamsAtPath -Path $packageJsonPath
      $packageJsonItem = Get-Item -LiteralPath $packageJsonPath -Force -ErrorAction Stop
      [void]$material.Add("package`0$relativePath/package.json`0$($packageJsonItem.Length)`0$((Get-FileHash -LiteralPath $packageJsonPath -Algorithm SHA256).Hash.ToLowerInvariant())")
    }
  }

  foreach ($nativeRelativePath in @(
    '@rspack/binding-win32-x64-msvc/rspack.win32-x64-msvc.node',
    '@tailwindcss/oxide-win32-x64-msvc/tailwindcss-oxide.win32-x64-msvc.node',
    'lightningcss-win32-x64-msvc/lightningcss.win32-x64-msvc.node'
  )) {
    $nativePath = Join-Path $nodeModulesRoot $nativeRelativePath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $nativePath -PathType Leaf)) {
      [void]$material.Add("native-absent`0$nativeRelativePath")
      continue
    }
    Assert-PathHasNoReparsePointAncestors -Path $nativePath
    Assert-NoAlternateDataStreamsAtPath -Path $nativePath
    $nativeItem = Get-Item -LiteralPath $nativePath -Force -ErrorAction Stop
    [void]$material.Add("native`0$nativeRelativePath`0$($nativeItem.Length)`0$((Get-FileHash -LiteralPath $nativePath -Algorithm SHA256).Hash.ToLowerInvariant())")
  }

  $quickFingerprint = Get-TextSha256 -Text (@($material | Sort-Object) -join "`n")
  return [pscustomobject][ordered]@{
    cacheKey = [System.IO.Path]::GetFullPath($nodeModulesRoot).ToLowerInvariant()
    fingerprint = $quickFingerprint
    packageRootCount = $packageRoots.Count
    baselinePackageSha256 = [string]$metadataHashes.baselinePackageSha256
    baselineLockSha256 = [string]$metadataHashes.baselineLockSha256
    candidatePackageSha256 = [string]$metadataHashes.candidatePackageSha256
    candidateLockSha256 = [string]$metadataHashes.candidateLockSha256
    verifierSha256 = [string]$metadataHashes.verifierSha256
    nodeSha256 = [string]$metadataHashes.nodeSha256
  }
}

function Invoke-InstalledDependencyProofGate {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [object]$Manifest,
    [switch]$CurrentReleaseOnly
  )

  $verifierRelativePath = 'operations/scripts/verify-hotfix-dependency-transition.mjs'
  $verifierPath = Join-Path $PackageRoot $verifierRelativePath.Replace('/', '\')
  if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
    throw 'The packaged dependency proof verifier is missing.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $verifierPath
  Assert-FinalPathContainedByRoot -Root $PackageRoot -Path $verifierPath
  Assert-NoAlternateDataStreamsAtPath -Path $verifierPath
  if ((Get-FileHash -LiteralPath $verifierPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$Manifest.dependencyVerifierSha256) {
    throw 'The packaged dependency proof verifier hash does not match the manifest.'
  }

  $candidateRoot = if ($CurrentReleaseOnly) { $Root } else { Join-Path $PackageRoot 'release-root' }
  foreach ($requiredPath in @(
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'package-lock.json'),
    (Join-Path $candidateRoot 'package.json'),
    (Join-Path $candidateRoot 'package-lock.json')
  )) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "The dependency proof input is missing: $requiredPath"
    }
    Assert-PathHasNoReparsePointAncestors -Path $requiredPath
    Assert-NoAlternateDataStreamsAtPath -Path $requiredPath
  }
  $installedNodeModules = Join-Path $Root 'node_modules'
  if (-not (Test-Path -LiteralPath $installedNodeModules -PathType Container)) {
    throw 'The installed production dependency directory is missing.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $installedNodeModules
  Assert-FinalPathContainedByRoot -Root $Root -Path $installedNodeModules

  $nodePath = Get-TrustedHotfixNodeExecutable -Root $Root
  $quickState = Get-InstalledDependencyQuickState `
    -Root $Root `
    -CandidateRoot $candidateRoot `
    -InstalledNodeModules $installedNodeModules `
    -VerifierPath $verifierPath `
    -NodePath $nodePath `
    -Manifest $Manifest
  $cacheKey = [string]$quickState.cacheKey
  if ($script:installedDependencyProofCache.ContainsKey($cacheKey)) {
    $cachedProof = $script:installedDependencyProofCache[$cacheKey]
    $baselineMetadataUnchanged = (
      [string]$quickState.baselinePackageSha256 -ceq [string]$cachedProof.baselinePackageSha256 -and
      [string]$quickState.baselineLockSha256 -ceq [string]$cachedProof.baselineLockSha256
    )
    $baselineMetadataIsCandidate = (
      [string]$quickState.baselinePackageSha256 -ceq [string]$quickState.candidatePackageSha256 -and
      [string]$quickState.baselineLockSha256 -ceq [string]$quickState.candidateLockSha256
    )
    if (
      [string]$cachedProof.quickFingerprint -ceq [string]$quickState.fingerprint -and
      [string]$cachedProof.candidatePackageSha256 -ceq [string]$quickState.candidatePackageSha256 -and
      [string]$cachedProof.candidateLockSha256 -ceq [string]$quickState.candidateLockSha256 -and
      [string]$cachedProof.verifierSha256 -ceq [string]$quickState.verifierSha256 -and
      [string]$cachedProof.nodeSha256 -ceq [string]$quickState.nodeSha256 -and
      ($baselineMetadataUnchanged -or $baselineMetadataIsCandidate)
    ) {
      $reusedReport = $cachedProof.report | ConvertTo-Json -Depth 32 -Compress | ConvertFrom-Json
      if ($baselineMetadataIsCandidate) {
        $reusedReport.transition = 'none'
      }
      Assert-DependencyProofMatchesManifest -Report $reusedReport -Manifest $Manifest
      Write-Host "[INFO] Reused the held production dependency proof after quick root, package-anchor, reparse and native-addon validation ($([int]$quickState.packageRootCount) package roots)."
      return $reusedReport
    }
    Write-Host '[INFO] Dependency quick proof changed; falling back to one complete physical-tree verification.'
  }
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'The per-user dependency proof cache directory is unavailable.'
  }
  $proofCacheDirectory = Join-Path $env:LOCALAPPDATA 'NantongSchedule\dependency-proof-cache'
  if (-not (Test-Path -LiteralPath $proofCacheDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $proofCacheDirectory -Force | Out-Null
  }
  Assert-PathHasNoReparsePointAncestors -Path $proofCacheDirectory
  $rootCacheKey = Get-TextSha256 -Text ([System.IO.Path]::GetFullPath($Root).TrimEnd('\').ToLowerInvariant())
  $proofCachePath = Join-Path $proofCacheDirectory "dependency-proof-$rootCacheKey.json"
  $arguments = @(
    $verifierPath,
    '--baseline-package', (Join-Path $Root 'package.json'),
    '--baseline-lock', (Join-Path $Root 'package-lock.json'),
    '--candidate-package', (Join-Path $candidateRoot 'package.json'),
    '--candidate-lock', (Join-Path $candidateRoot 'package-lock.json'),
    '--installed-node-modules', $installedNodeModules,
    '--proof-cache', $proofCachePath
  )
  $output = @(& $nodePath @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $outputLines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($exitCode -ne 0) {
    $diagnostic = if ($outputLines.Count -gt 0) { $outputLines[-1] } else { 'no verifier output' }
    throw "The installed dependency proof verifier failed: $diagnostic"
  }
  if ($outputLines.Count -ne 1) {
    throw 'The installed dependency proof verifier did not emit exactly one JSON report.'
  }
  try {
    $report = $outputLines[0] | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'The installed dependency proof verifier emitted invalid JSON.'
  }
  Assert-DependencyProofMatchesManifest -Report $report -Manifest $Manifest
  $quickStateAfter = Get-InstalledDependencyQuickState `
    -Root $Root `
    -CandidateRoot $candidateRoot `
    -InstalledNodeModules $installedNodeModules `
    -VerifierPath $verifierPath `
    -NodePath $nodePath `
    -Manifest $Manifest
  if ([string]$quickStateAfter.fingerprint -cne [string]$quickState.fingerprint) {
    throw 'The production dependency quick proof changed while the complete verification was running.'
  }
  $script:installedDependencyProofCache[$cacheKey] = [pscustomobject][ordered]@{
    quickFingerprint = [string]$quickStateAfter.fingerprint
    baselinePackageSha256 = [string]$quickStateAfter.baselinePackageSha256
    baselineLockSha256 = [string]$quickStateAfter.baselineLockSha256
    candidatePackageSha256 = [string]$quickStateAfter.candidatePackageSha256
    candidateLockSha256 = [string]$quickStateAfter.candidateLockSha256
    verifierSha256 = [string]$quickStateAfter.verifierSha256
    nodeSha256 = [string]$quickStateAfter.nodeSha256
    report = $report
  }
  return $report
}

function Write-DurableDependencyReadyStamp {
  param([string]$Root)

  $stampPath = Join-Path $Root '.deps-ready.json'
  Assert-PathHasNoReparsePointAncestors -Path $stampPath
  Assert-FinalPathContainedByRoot -Root $Root -Path $stampPath
  if ((Test-Path -LiteralPath $stampPath) -and -not (Test-Path -LiteralPath $stampPath -PathType Leaf)) {
    throw 'The dependency-ready stamp path is not a regular file.'
  }
  if (Test-Path -LiteralPath $stampPath -PathType Leaf) {
    Assert-NoAlternateDataStreamsAtPath -Path $stampPath
  }

  $hashOrEmpty = {
    param([string]$RelativePath)
    $fullPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      return ''
    }
    Assert-PathHasNoReparsePointAncestors -Path $fullPath
    Assert-FinalPathContainedByRoot -Root $Root -Path $fullPath
    Assert-NoAlternateDataStreamsAtPath -Path $fullPath
    return (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
  }
  $stamp = [ordered]@{
    packageLock = & $hashOrEmpty 'package-lock.json'
    postinstallScript = & $hashOrEmpty 'scripts/postinstall.mjs'
    feishuCardPatchScript = & $hashOrEmpty 'scripts/ensure-feishu-card-ws-sdk-patch.mjs'
    installedAt = (Get-Date).ToString('s')
  }
  $json = $stamp | ConvertTo-Json -Compress
  $temporaryPath = "$stampPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $stream = [System.IO.File]::Open(
    $temporaryPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  try {
    Move-DurableAtomicFileWithRetry -Source $temporaryPath -Destination $stampPath -Label 'dependency-ready stamp'
  } catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    throw
  }
  Write-Host '[INFO] Durable dependency-ready stamp refreshed from the proven installed tree.'
}

function Wait-ProcessIdsExit {
  param(
    [int[]]$ProcessIds,
    [int]$TimeoutSeconds = 15
  )
  $trackedProcessIds = @($ProcessIds | Sort-Object -Unique)
  if ($trackedProcessIds.Count -eq 0) {
    return
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $remainingProcessIds = @(
      foreach ($trackedProcessId in $trackedProcessIds) {
        if (Get-Process -Id $trackedProcessId -ErrorAction SilentlyContinue) {
          $trackedProcessId
        }
      }
    )
    if ($remainingProcessIds.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "Processes did not exit before the deployment timeout: $($remainingProcessIds -join ', ')"
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $treeProcessIds = New-Object 'System.Collections.Generic.List[int]'
  [void]$treeProcessIds.Add($ProcessId)
  for ($index = 0; $index -lt $treeProcessIds.Count; $index += 1) {
    $parentProcessId = $treeProcessIds[$index]
    foreach ($process in @($allProcesses | Where-Object { $_.ParentProcessId -eq $parentProcessId })) {
      $childProcessId = [int]$process.ProcessId
      if (-not $treeProcessIds.Contains($childProcessId)) {
        [void]$treeProcessIds.Add($childProcessId)
      }
    }
  }
  $processIdsToStop = @($treeProcessIds | ForEach-Object { [int]$_ })
  [array]::Reverse($processIdsToStop)
  foreach ($treeProcessId in $processIdsToStop) {
    if ($treeProcessId -ne $PID) {
      Stop-Process -Id $treeProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Wait-ProcessIdsExit -ProcessIds $processIdsToStop
}

function Complete-LauncherCapture {
  param([System.Diagnostics.Process]$LauncherProcess)

  if ($null -eq $LauncherProcess) {
    return
  }
  $completedProperty = $LauncherProcess.PSObject.Properties['LauncherCaptureCompleted']
  if ($null -eq $completedProperty -or [bool]$completedProperty.Value) {
    return
  }
  $LauncherProcess.Refresh()
  if (-not $LauncherProcess.HasExited) {
    return
  }
  $LauncherProcess.WaitForExit()
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $stdoutPath = [string]$LauncherProcess.PSObject.Properties['LauncherStdoutPath'].Value
  $stderrPath = [string]$LauncherProcess.PSObject.Properties['LauncherStderrPath'].Value
  $summaryPath = [string]$LauncherProcess.PSObject.Properties['LauncherLogPath'].Value
  $summary = @(
    "[$((Get-Date).ToUniversalTime().ToString('o'))] $([string]$LauncherProcess.PSObject.Properties['LauncherKind'].Value) launcher exit $($LauncherProcess.ExitCode)",
    "stdout: $stdoutPath",
    "stderr: $stderrPath"
  ) -join "`r`n"
  [System.IO.File]::AppendAllText($summaryPath, "$summary`r`n", $utf8NoBom)
  $completedProperty.Value = $true
}

function Write-LauncherLogTail {
  param([string]$Path, [string]$Label)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "[WARN] $Label file is missing: $Path" -ForegroundColor Yellow
    return $false
  }
  $lines = @(Get-Content -LiteralPath $Path -Tail 80 -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0 -or [string]::IsNullOrWhiteSpace(($lines -join "`n"))) {
    Write-Host "[WARN] $Label file is empty (0 bytes): $Path" -ForegroundColor Yellow
    return $false
  }
  Write-Host "[WARN] $Label" -ForegroundColor Yellow
  foreach ($line in $lines) {
    Write-Host ([string]$line)
  }
  return $true
}

function Write-LauncherDiagnostics {
  param([System.Diagnostics.Process]$LauncherProcess, [string]$Root)

  Complete-LauncherCapture -LauncherProcess $LauncherProcess
  $stdoutPath = [string]$LauncherProcess.PSObject.Properties['LauncherStdoutPath'].Value
  $stderrPath = [string]$LauncherProcess.PSObject.Properties['LauncherStderrPath'].Value
  Write-Host "[WARN] Runtime launcher stdout: $stdoutPath" -ForegroundColor Yellow
  Write-Host "[WARN] Runtime launcher stderr: $stderrPath" -ForegroundColor Yellow
  $printed = Write-LauncherLogTail -Path $stderrPath -Label 'Runtime launcher stderr tail:'
  if (Write-LauncherLogTail -Path $stdoutPath -Label 'Runtime launcher stdout tail:') {
    $printed = $true
  }
  if (-not $printed) {
    [void](Write-LauncherLogTail -Path (Join-Path $Root 'logs\app.err.log') -Label 'Application stderr tail:')
    [void](Write-LauncherLogTail -Path (Join-Path $Root 'logs\app.out.log') -Label 'Application stdout tail:')
    [void](Write-LauncherLogTail -Path (Join-Path $Root 'logs\hotfix-recovery.err.log') -Label 'Recovery stderr tail:')
    [void](Write-LauncherLogTail -Path (Join-Path $Root 'logs\hotfix-recovery.out.log') -Label 'Recovery stdout tail:')
  }
}

function Stop-LauncherProcessTree {
  param([System.Diagnostics.Process]$LauncherProcess)

  if ($null -eq $LauncherProcess) {
    return
  }
  try {
    $LauncherProcess.Refresh()
  } catch {
    return
  }
  if ($LauncherProcess.HasExited) {
    Complete-LauncherCapture -LauncherProcess $LauncherProcess
    return
  }
  $expectedStartTimeUtc = $LauncherProcess.StartTime.ToUniversalTime()
  $currentLauncher = Get-Process -Id $LauncherProcess.Id -ErrorAction SilentlyContinue
  if (
    $null -eq $currentLauncher -or
    [Math]::Abs((
      $currentLauncher.StartTime.ToUniversalTime() - $expectedStartTimeUtc
    ).TotalMilliseconds) -ge 1000
  ) {
    throw 'The replacement launcher PID was reused; its process tree was not terminated.'
  }
  Stop-ProcessTree -ProcessId $LauncherProcess.Id
  $LauncherProcess.Refresh()
  Complete-LauncherCapture -LauncherProcess $LauncherProcess
}

function Get-TcpListenOwnerProcessIds {
  param([int]$Port)

  $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
  if (Test-Path -LiteralPath $netstatPath -PathType Leaf) {
    try {
      $lines = @(& $netstatPath -ano -p tcp 2>$null)
      if ($LASTEXITCODE -eq 0) {
        $owners = @(
          foreach ($line in $lines) {
            $match = [regex]::Match(
              [string]$line,
              '^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$',
              [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
            )
            if (-not $match.Success) {
              continue
            }
            $localEndpoint = [string]$match.Groups[1].Value
            $portSeparator = $localEndpoint.LastIndexOf(':')
            $parsedPort = 0
            if (
              $portSeparator -ge 0 -and
              [int]::TryParse($localEndpoint.Substring($portSeparator + 1), [ref]$parsedPort) -and
              $parsedPort -eq $Port
            ) {
              [int]$match.Groups[3].Value
            }
          }
        )
        return @($owners | Sort-Object -Unique)
      }
    } catch {
      Write-Host '[WARN] netstat listener proof was unavailable; using Get-NetTCPConnection.' -ForegroundColor Yellow
    }
  }
  return @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { [int]$_.OwningProcess } |
      Sort-Object -Unique
  )
}

function Assert-AppProcessesStopped {
  param(
    [string]$Root,
    [string]$Endpoint
  )

  if (@(Get-AppProcesses -Root $Root).Count -ne 0) {
    throw 'The application Node process is still running after the stop timeout.'
  }
  $endpointUri = [Uri]$Endpoint
  $listenerOwners = @(Get-TcpListenOwnerProcessIds -Port $endpointUri.Port)
  if ($listenerOwners.Count -ne 0) {
    throw "The application health port is still listening after stop: $($endpointUri.Port)"
  }
}

function Stop-AppProcesses {
  param(
    [string]$Root,
    [string]$Endpoint,
    [switch]$AllowNotRunning,
    [switch]$AllowStaleOwnedJsonPidRecord,
    [switch]$RequireJsonRecord,
    [AllowNull()]
    [object]$NotBeforeUtc
  )

  try {
    $processes = @(
      Get-AppProcesses `
        -Root $Root `
        -RequireRunning:(-not $AllowNotRunning) `
        -RequireJsonRecord:$RequireJsonRecord `
        -NotBeforeUtc $NotBeforeUtc
    )
  } catch {
    if (-not $AllowStaleOwnedJsonPidRecord) {
      throw
    }
    $pidPath = Join-Path $Root 'app.pid'
    try {
      $record = ([System.IO.File]::ReadAllText(
        $pidPath,
        [System.Text.UTF8Encoding]::new($false)
      )) | ConvertFrom-Json -ErrorAction Stop
      $expectedRootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
      $expectedMainPath = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist\server\main.js'))
      $recordedRootPath = [System.IO.Path]::GetFullPath([string]$record.appRoot).TrimEnd('\')
      $recordedMainPath = [System.IO.Path]::GetFullPath([string]$record.mainFile)
      $recordedProcessId = [int]$record.pid
      Assert-ExactObjectProperties `
        -Object $record `
        -ExpectedNames @('schemaVersion', 'pid', 'startTime', 'appRoot', 'mainFile') `
        -Context 'The stopped replacement app.pid record'
      if (
        [int]$record.schemaVersion -ne 1 -or
        $recordedProcessId -le 0 -or
        -not [string]::Equals($recordedRootPath, $expectedRootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($recordedMainPath, $expectedMainPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $null -ne (Get-Process -Id $recordedProcessId -ErrorAction SilentlyContinue)
      ) {
        throw 'unsafe stale pid record'
      }
      Remove-Item -LiteralPath $pidPath -Force
      $processes = @()
    } catch {
      throw 'The stopped replacement app.pid record is not a safe owned stale record. Rollback was refused.'
    }
  }
  foreach ($process in $processes) {
    $confirmedProcess = Confirm-ValidatedNodeProcessIdentity -ValidatedProcess $process
    if ([bool]$confirmedProcess.AllowLegacyRelativeEntryPoint) {
      [void](Confirm-HealthListenerOwnership `
        -Endpoint $Endpoint `
        -ValidatedProcess $confirmedProcess)
    }
    Stop-Process -Id $confirmedProcess.ProcessId -Force -ErrorAction Stop
  }
  Wait-ProcessIdsExit -ProcessIds @($processes | ForEach-Object { [int]$_.ProcessId })
  $pidPath = Join-Path $Root 'app.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    Remove-Item -LiteralPath $pidPath -Force
  }
  Assert-AppProcessesStopped -Root $Root -Endpoint $Endpoint
}

function Get-DotEnvValue {
  param(
    [string]$FilePath,
    [string]$Name,
    [string]$DefaultValue
  )

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return $DefaultValue
  }
  foreach ($line in Get-Content -LiteralPath $FilePath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) {
      continue
    }
    $parts = $trimmed.Split('=', 2)
    if ($parts[0].Trim() -ceq $Name) {
      return $parts[1].Trim().Trim('"').Trim("'")
    }
  }
  return $DefaultValue
}

function Get-ConfiguredValue {
  param(
    [string]$Root,
    [string]$Name,
    [string]$DefaultValue
  )

  $configured = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $configured = $DefaultValue
  }
  $configured = Get-DotEnvValue -FilePath (Join-Path $Root '.env') -Name $Name -DefaultValue $configured
  return Get-DotEnvValue -FilePath (Join-Path $Root '.env.local') -Name $Name -DefaultValue $configured
}

function Test-ConfiguredValuePresent {
  param(
    [string]$Root,
    [string]$Name
  )
  return -not [string]::IsNullOrWhiteSpace((Get-ConfiguredValue -Root $Root -Name $Name -DefaultValue ''))
}

function Test-CardCallbackWorkflowEnabled {
  param([string]$Root)

  $consumerConfigured = Get-ConfiguredValue -Root $Root -Name 'FEISHU_CARD_ACTION_CONSUMER_ENABLED' -DefaultValue ''
  $consumerEnabled = if ([string]::IsNullOrWhiteSpace($consumerConfigured)) {
    Test-Path -LiteralPath (Join-Path $Root '.feishu-card-action-consumer-release') -PathType Leaf
  } else {
    @('true', '1', 'on', 'yes') -contains $consumerConfigured.Trim().ToLowerInvariant()
  }
  if (-not $consumerEnabled) {
    return $false
  }

  $inventoryEnabled = $true
  foreach ($name in @('FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID')) {
    if (-not (Test-ConfiguredValuePresent -Root $Root -Name $name)) {
      $inventoryEnabled = $false
      break
    }
  }
  if ($inventoryEnabled) {
    $inventoryEnabled = (
      (Test-ConfiguredValuePresent -Root $Root -Name 'FEISHU_WAREHOUSE_APP_TOKEN') -or
      (Test-ConfiguredValuePresent -Root $Root -Name 'FEISHU_WAREHOUSE_SOURCE_URL')
    )
  }
  if ($inventoryEnabled) {
    return $true
  }

  $overtime = Get-ConfiguredValue -Root $Root -Name 'OVERTIME_WORKFLOW_PROGRAM_ENABLED' -DefaultValue 'true'
  if (@('false', '0', 'off', 'no') -notcontains $overtime.Trim().ToLowerInvariant()) {
    return $true
  }
  foreach ($name in @('PURCHASE_WORKFLOW_PROGRAM_ENABLED', 'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED')) {
    $configured = Get-ConfiguredValue -Root $Root -Name $name -DefaultValue 'false'
    if (@('true', '1', 'on', 'yes') -contains $configured.Trim().ToLowerInvariant()) {
      return $true
    }
  }
  return $false
}

function Get-CardCallbackHealthEndpoint {
  param(
    [string]$Root,
    [string]$AccessEndpoint
  )

  $accessUri = [Uri]$AccessEndpoint
  $clientBasePath = (Get-ConfiguredValue -Root $Root -Name 'CLIENT_BASE_PATH' -DefaultValue '').Trim().Trim('/')
  $pathPrefix = if ($clientBasePath) { "/$clientBasePath" } else { '' }
  $builder = [UriBuilder]::new($accessUri.Scheme, $accessUri.Host, $accessUri.Port, "$pathPrefix/api/feishu-card-callback/health")
  return $builder.Uri.AbsoluteUri
}

function Test-JsonHealthContract {
  param(
    [string]$Endpoint,
    [ValidateSet('access', 'callback')]
    [string]$Contract
  )

  $reader = $null
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Endpoint)
    $request.Method = 'GET'
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) {
      return $false
    }
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
    $body = $reader.ReadToEnd() | ConvertFrom-Json
    if ($Contract -eq 'access') {
      return ($null -ne $body.role -and $null -ne $body.capabilities)
    }
    return ([bool]$body.enabled -and [bool]$body.ready)
  } catch {
    return $false
  } finally {
    if ($reader) {
      $reader.Dispose()
    }
    if ($response) {
      $response.Dispose()
    }
  }
}

function Start-App {
  param(
    [string]$Root,
    [AllowNull()]
    [string]$StartScriptPath,
    [AllowNull()]
    [string]$DependencyProofFingerprint
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $startScript = if ([string]::IsNullOrWhiteSpace($StartScriptPath)) {
    Join-Path $Root 'start.ps1'
  } else {
    [System.IO.Path]::GetFullPath($StartScriptPath)
  }
  if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "The application launcher script is missing: $startScript"
  }
  $startParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $startScript)).TrimEnd('\', '/')
  if (-not [string]::Equals($startParent, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The application launcher script must be a direct child of the application root.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $startScript
  Assert-FinalPathContainedByRoot -Root $rootPath -Path $startScript
  Assert-NoAlternateDataStreamsAtPath -Path $startScript
  $powershellPath = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    $powershellPath = 'powershell.exe'
  }

  $launcherKind = if ([string]::IsNullOrWhiteSpace($StartScriptPath)) { 'candidate' } else { 'recovery' }
  $launcherAttemptId = "$(Get-Date -Format 'yyyyMMddHHmmssfff')-$([Guid]::NewGuid().ToString('N'))"
  $launcherLogPath = Join-Path $Root 'logs\hotfix-launcher.log'
  $launcherStdoutPath = Join-Path $Root "logs\hotfix-launcher-$launcherKind-$launcherAttemptId.out.log"
  $launcherStderrPath = Join-Path $Root "logs\hotfix-launcher-$launcherKind-$launcherAttemptId.err.log"
  $launcherLogParent = Split-Path -Parent $launcherLogPath
  if (-not (Test-Path -LiteralPath $launcherLogParent -PathType Container)) {
    New-Item -ItemType Directory -Path $launcherLogParent -Force | Out-Null
  }
  foreach ($logPath in @($launcherLogPath, $launcherStdoutPath, $launcherStderrPath)) {
    Assert-PathHasNoReparsePointAncestors -Path $logPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $logPath
    if (Test-Path -LiteralPath $logPath) {
      if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
        throw 'A hotfix launcher log path is not a file.'
      }
      Assert-NoAlternateDataStreamsAtPath -Path $logPath
    }
  }
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  if (-not (Test-Path -LiteralPath $launcherLogPath -PathType Leaf)) {
    [System.IO.File]::WriteAllText($launcherLogPath, '', $utf8NoBom)
  }
  [System.IO.File]::WriteAllText($launcherStdoutPath, '', $utf8NoBom)
  [System.IO.File]::WriteAllText($launcherStderrPath, '', $utf8NoBom)

  $commandProcessorPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
  if (-not (Test-Path -LiteralPath $commandProcessorPath -PathType Leaf)) {
    throw 'The Windows command processor required for isolated launcher logging is missing.'
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $commandProcessorPath
  $startInfo.Arguments = '/d /v:off /s /c ""%NANTONG_HOTFIX_LAUNCHER_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%NANTONG_HOTFIX_LAUNCHER_SCRIPT%" -NoBrowser 1>"%NANTONG_HOTFIX_LAUNCHER_STDOUT%" 2>"%NANTONG_HOTFIX_LAUNCHER_STDERR%""'
  $startInfo.WorkingDirectory = $rootPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  [void]$startInfo.EnvironmentVariables.Remove('NANTONG_HOTFIX_SMOKE_MODE')
  [void]$startInfo.EnvironmentVariables.Remove('NANTONG_ATOMIC_HOTFIX_MODE')
  [void]$startInfo.EnvironmentVariables.Remove('NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF')
  [void]$startInfo.EnvironmentVariables.Remove('NANTONG_HOTFIX_RECOVERY_NODE_PATH')
  if ([string]::IsNullOrWhiteSpace($StartScriptPath)) {
    if ($DependencyProofFingerprint -cnotmatch '^[0-9a-f]{64}$') {
      throw 'The candidate launcher requires a validated dependency physical-tree fingerprint.'
    }
    $startInfo.EnvironmentVariables['NANTONG_ATOMIC_HOTFIX_MODE'] = 'verified-physical-tree'
    $startInfo.EnvironmentVariables['NANTONG_ATOMIC_HOTFIX_DEPENDENCY_PROOF'] = $DependencyProofFingerprint
  } else {
    $startInfo.EnvironmentVariables['NANTONG_HOTFIX_RECOVERY_NODE_PATH'] = `
      Get-TrustedHotfixNodeExecutable -Root $Root
  }
  $startInfo.EnvironmentVariables['NANTONG_HOTFIX_LAUNCHER_POWERSHELL'] = $powershellPath
  $startInfo.EnvironmentVariables['NANTONG_HOTFIX_LAUNCHER_SCRIPT'] = $startScript
  $startInfo.EnvironmentVariables['NANTONG_HOTFIX_LAUNCHER_STDOUT'] = $launcherStdoutPath
  $startInfo.EnvironmentVariables['NANTONG_HOTFIX_LAUNCHER_STDERR'] = $launcherStderrPath
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'The application launcher process could not be started.'
  }
  $process | Add-Member -NotePropertyName LauncherLogPath -NotePropertyValue $launcherLogPath
  $process | Add-Member -NotePropertyName LauncherStdoutPath -NotePropertyValue $launcherStdoutPath
  $process | Add-Member -NotePropertyName LauncherStderrPath -NotePropertyValue $launcherStderrPath
  $process | Add-Member -NotePropertyName LauncherCaptureCompleted -NotePropertyValue $false
  $process | Add-Member -NotePropertyName LauncherKind -NotePropertyValue $launcherKind
  return $process
}

function Confirm-HealthListenerOwnership {
  param(
    [string]$Endpoint,
    [object]$ValidatedProcess
  )

  $endpointUri = [Uri]$Endpoint
  $listenerOwners = @(Get-TcpListenOwnerProcessIds -Port $endpointUri.Port)
  if ($listenerOwners -notcontains [int]$ValidatedProcess.ProcessId) {
    throw "The healthy endpoint listener is not owned by the validated application process: $($endpointUri.Port)"
  }
  return $ValidatedProcess
}

function Wait-AppHealth {
  param(
    [int]$TimeoutSeconds,
    [string]$Endpoint,
    [string]$Root,
    [System.Diagnostics.Process]$LauncherProcess,
    [AllowNull()]
    [object]$ExpectedProcessStartedAfterUtc
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $requiredConsecutiveSuccesses = 2
  $minimumHealthyWindowMilliseconds = 1500
  $consecutiveSuccesses = 0
  $healthyWindowStartedUtc = $null
  $launcherCompleted = $null -eq $LauncherProcess
  $lastFailure = if ($launcherCompleted) {
    'runtime process proof and health contract have not passed'
  } else {
    'launcher process has not exited'
  }
  $callbackRequired = Test-CardCallbackWorkflowEnabled -Root $Root
  $callbackEndpoint = if ($callbackRequired) {
    Get-CardCallbackHealthEndpoint -Root $Root -AccessEndpoint $Endpoint
  } else {
    $null
  }
  $nextProgressUtc = (Get-Date).AddSeconds(15)
  $previousCertificateCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
  try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {
      param($sender, $certificate, $chain, $sslPolicyErrors)
      return $true
    }
    while ((Get-Date) -lt $deadline) {
      if ((Get-Date) -ge $nextProgressUtc) {
        $remainingSeconds = [Math]::Max(0, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
        Write-Host "[INFO] Waiting for runtime health: $lastFailure; $remainingSeconds second(s) remain."
        $nextProgressUtc = (Get-Date).AddSeconds(15)
      }
      if ($LauncherProcess -and -not $launcherCompleted) {
        $LauncherProcess.Refresh()
        if (-not $LauncherProcess.HasExited) {
          $lastFailure = 'launcher process has not exited'
          Start-Sleep -Milliseconds 200
          continue
        }
        $LauncherProcess.WaitForExit()
        $LauncherProcess.Refresh()
        Complete-LauncherCapture -LauncherProcess $LauncherProcess
        if ($LauncherProcess.ExitCode -ne 0) {
          Write-Host "[WARN] Runtime launcher exited with code $($LauncherProcess.ExitCode)." -ForegroundColor Yellow
          Write-LauncherDiagnostics -LauncherProcess $LauncherProcess -Root $Root
          return $false
        }
        $launcherCompleted = $true
      }

      try {
        $validatedProcess = $null
        if ($LauncherProcess) {
          $validatedProcess = Get-VerifiedPidFileProcess `
            -Root $Root `
            -RequireJsonRecord `
            -NotBeforeUtc $ExpectedProcessStartedAfterUtc
        } else {
          $validatedProcess = @(Get-AppProcesses -Root $Root -RequireRunning)[0]
        }
      } catch {
        $lastFailure = "runtime process proof failed: $($_.Exception.Message)"
        $consecutiveSuccesses = 0
        $healthyWindowStartedUtc = $null
        Start-Sleep -Milliseconds 500
        continue
      }

      $accessHealthy = Test-JsonHealthContract -Endpoint $Endpoint -Contract access
      $callbackHealthy = -not $callbackRequired -or (
        Test-JsonHealthContract -Endpoint $callbackEndpoint -Contract callback
      )
      if ($accessHealthy -and $callbackHealthy) {
        try {
          if ($null -eq $healthyWindowStartedUtc) {
            $healthyWindowStartedUtc = (Get-Date).ToUniversalTime()
          }
          $consecutiveSuccesses += 1
          $healthyWindowElapsed = ((Get-Date).ToUniversalTime() - $healthyWindowStartedUtc).TotalMilliseconds
          if ($healthyWindowElapsed -lt $minimumHealthyWindowMilliseconds) {
            Start-Sleep -Milliseconds ([int]($minimumHealthyWindowMilliseconds - $healthyWindowElapsed))
          }
          $accessStable = Test-JsonHealthContract -Endpoint $Endpoint -Contract access
          $callbackStable = -not $callbackRequired -or (
            Test-JsonHealthContract -Endpoint $callbackEndpoint -Contract callback
          )
          if ($accessStable -and $callbackStable) {
            $consecutiveSuccesses = $requiredConsecutiveSuccesses
            Start-Sleep -Milliseconds 250
            $validatedProcess = Confirm-ValidatedNodeProcessIdentity `
              -ValidatedProcess $validatedProcess
            [void](Confirm-HealthListenerOwnership `
              -Endpoint $Endpoint `
              -ValidatedProcess $validatedProcess)
            return $true
          }
          $lastFailure = 'health contract did not remain stable after the verification window'
          $consecutiveSuccesses = 0
          $healthyWindowStartedUtc = $null
        } catch {
          $lastFailure = "runtime listener proof failed: $($_.Exception.Message)"
          $consecutiveSuccesses = 0
          $healthyWindowStartedUtc = $null
        }
      } else {
        $lastFailure = if (-not $accessHealthy) {
          'access health contract did not pass'
        } else {
          'Feishu card callback health contract did not pass'
        }
        $consecutiveSuccesses = 0
        $healthyWindowStartedUtc = $null
      }
      Start-Sleep -Milliseconds 500
    }
    Write-Host "[WARN] Runtime health verification timed out: $lastFailure" -ForegroundColor Yellow
    if ($LauncherProcess) {
      $LauncherProcess.Refresh()
      if ($LauncherProcess.HasExited) {
        Write-LauncherDiagnostics -LauncherProcess $LauncherProcess -Root $Root
      } else {
        Write-Host "[WARN] Runtime launcher is still running; stdout: $([string]$LauncherProcess.PSObject.Properties['LauncherStdoutPath'].Value)" -ForegroundColor Yellow
        Write-Host "[WARN] Runtime launcher is still running; stderr: $([string]$LauncherProcess.PSObject.Properties['LauncherStderrPath'].Value)" -ForegroundColor Yellow
      }
    }
    return $false
  } finally {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCertificateCallback
  }
}

function Write-DurableMaintenanceOwner {
  param(
    [string]$Path,
    [object]$Transaction,
    [string]$AppRoot
  )

  $ownerProcess = Get-Process -Id $PID -ErrorAction Stop
  $transactionId = [string]$Transaction.transactionId
  $owner = [ordered]@{
    schemaVersion = 1
    pid = $PID
    processStartTime = $ownerProcess.StartTime.ToUniversalTime().ToString('o')
    transactionId = $transactionId
    deploymentId = [string]$Transaction.deploymentId
    appRoot = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
  } | ConvertTo-Json -Compress
  $maintenanceStream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($owner)
    $maintenanceStream.Write($bytes, 0, $bytes.Length)
    $maintenanceStream.Flush($true)
  } finally {
    $maintenanceStream.Dispose()
  }
}

function Resolve-HotfixMaintenanceOwner {
  param(
    [string]$Path,
    [AllowNull()]
    [object]$Transaction,
    [string]$AppRoot
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  if ($null -eq $Transaction) {
    throw 'The maintenance owner is dead but its durable transaction journal is missing.'
  }
  try {
    $owner = ([System.IO.File]::ReadAllText(
      $Path,
      [System.Text.UTF8Encoding]::new($false)
    )) |
      ConvertFrom-Json -ErrorAction Stop
    Assert-ExactObjectProperties `
      -Object $owner `
      -ExpectedNames @(
        'schemaVersion', 'pid', 'processStartTime', 'transactionId',
        'deploymentId', 'appRoot'
      ) `
      -Context 'The deployment maintenance owner'
    $ownerStartTime = [DateTime]::Parse(
      [string]$owner.processStartTime,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    if (
      [int]$owner.schemaVersion -ne 1 -or
      [int]$owner.pid -le 0 -or
      [string]$owner.transactionId -cne [string]$Transaction.transactionId -or
      [string]$owner.deploymentId -cne [string]$Transaction.deploymentId -or
      -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$owner.appRoot).TrimEnd('\'),
        [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\'),
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw 'maintenance owner does not match its transaction'
    }
  } catch {
    throw "The deployment maintenance owner failed strict validation: $($_.Exception.Message)"
  }
  $liveOwner = Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue
  if (
    $liveOwner -and
    [Math]::Abs(($liveOwner.StartTime.ToUniversalTime() - $ownerStartTime).TotalMilliseconds) -lt 1000
  ) {
    throw 'Another hotfix installer still owns the deployment maintenance transaction.'
  }
  Write-Host '[WARN] The maintenance owner is dead; recovery will use its validated durable transaction journal.' -ForegroundColor Yellow
}

function Test-FileHashEquals {
  param([string]$Path, [string]$ExpectedHash)
  return (
    (Test-Path -LiteralPath $Path -PathType Leaf) -and
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExpectedHash
  )
}

function Test-SemanticallyEquivalentConsumerReleaseMarker {
  param(
    [string]$Path,
    [string]$RelativePath
  )
  if (
    $RelativePath -cne '.feishu-card-action-consumer-release' -or
    -not (Test-Path -LiteralPath $Path -PathType Leaf)
  ) {
    return $false
  }
  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
    try {
      $reader = New-Object System.IO.StreamReader(
        $stream,
        [System.Text.Encoding]::UTF8,
        $true
      )
      try {
        $value = $reader.ReadToEnd().Trim().Trim([char]0xFEFF).Trim()
      } finally {
        $reader.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $false
  }
  return @(
    'FEISHU_CARD_ACTION_CONSUMER_RELEASE_V1',
    'today-operations-anomaly'
  ) -ccontains $value
}

function Move-HotfixRecoveryArtifact {
  param(
    [string]$Root,
    [string]$TransactionId,
    [string]$Source,
    [string]$Name
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    return
  }
  $artifactRoot = Join-Path $Root ".hotfix-recovery-artifacts\$TransactionId"
  New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
  $destination = Join-Path $artifactRoot $Name
  if (Test-Path -LiteralPath $destination) {
    throw "A recovery artifact already exists while its source also remains: $Name"
  }
  Move-ItemWithRetry -LiteralPath $Source -Destination $destination
}

function Restore-ReleaseFilesFromTransaction {
  param(
    [string]$Root,
    [string]$BackupRoot,
    [object]$Transaction
  )
  foreach ($entry in @($Transaction.releaseFiles)) {
    $relativePath = [string]$entry.targetPath
    $targetPath = Resolve-AppRootTargetPath -Root $Root -RelativePath $relativePath
    $backupPath = Resolve-AppRootTargetPath -Root $BackupRoot -RelativePath $relativePath
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      if (Test-Path -LiteralPath $targetPath) {
        Move-HotfixRecoveryArtifact `
          -Root $Root `
          -TransactionId ([string]$Transaction.transactionId) `
          -Source $targetPath `
          -Name ("release-candidate-" + (Get-TextSha256 -Text $relativePath))
      }
      New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
      Move-ItemWithRetry -LiteralPath $backupPath -Destination $targetPath
      continue
    }
    if ([bool]$entry.baselineExisted) {
      if (-not (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$entry.baselineSha256))) {
        throw "The release-file rollback backup is missing and the baseline target cannot be proven: $relativePath"
      }
    } elseif (Test-Path -LiteralPath $targetPath) {
      if (-not (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$entry.candidateSha256))) {
        throw "An unexpected release target blocks transaction recovery: $relativePath"
      }
      Move-HotfixRecoveryArtifact `
        -Root $Root `
        -TransactionId ([string]$Transaction.transactionId) `
        -Source $targetPath `
        -Name ("release-new-" + (Get-TextSha256 -Text $relativePath))
    }
  }
}

function Get-VerifiedRecoveryStartManifestEntry {
  param([object]$Manifest)
  $entries = @(
    $Manifest.supportFiles |
      Where-Object { [string]$_.path -ceq 'operations/deploy/hotfix-recovery-start.ps1' }
  )
  if ($entries.Count -ne 1) {
    throw 'The package must contain exactly one integrity-checked recovery launcher.'
  }
  return $entries[0]
}

function New-VerifiedRecoveryStartScript {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [object]$Manifest,
    [object]$Transaction
  )
  $entry = Get-VerifiedRecoveryStartManifestEntry -Manifest $Manifest
  $recoveryId = Get-TextSha256 -Text ([string]$Transaction.transactionId)
  $recoveryName = '.hotfix-recovery-start.' + $recoveryId + '.ps1'
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $destination = [System.IO.Path]::GetFullPath((Join-Path $rootPath $recoveryName))
  $destinationParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $destination)).TrimEnd('\', '/')
  if (-not [string]::Equals($destinationParent, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The recovery launcher path must be a direct child of the application root.'
  }
  Assert-PathHasNoReparsePointAncestors -Path $destination
  Assert-FinalPathContainedByRoot -Root $rootPath -Path $destination
  $sourceHandles = $null
  $destinationLock = $null
  $createdDestination = $false
  try {
    $sourceHandles = Open-VerifiedIntegrityHandles `
      -Root $PackageRoot `
      -Entries @($entry)
    if (Test-Path -LiteralPath $destination) {
      if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        throw 'The recovery launcher path is blocked by a non-file entry.'
      }
      Assert-NoAlternateDataStreamsAtPath -Path $destination
      $existingItem = Get-Item -LiteralPath $destination -Force
      if (
        $existingItem.Length -ne [int64]$entry.size -or
        -not (Test-FileHashEquals -Path $destination -ExpectedHash ([string]$entry.sha256))
      ) {
        throw 'An existing recovery launcher does not match the package manifest.'
      }
    } else {
      $createdDestination = $true
      Write-HeldIntegrityFile `
        -IntegrityHandles $sourceHandles `
        -RelativePath ([string]$entry.path) `
        -Destination $destination
    }
    Assert-PathHasNoReparsePointAncestors -Path $destination
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $destination
    Assert-NoAlternateDataStreamsAtPath -Path $destination
    $destinationLock = [System.IO.File]::Open(
      $destination,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
    if ($destinationLock.Length -ne [int64]$entry.size) {
      throw 'The locked recovery launcher has the wrong size.'
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      $actualHash = ([System.BitConverter]::ToString($algorithm.ComputeHash($destinationLock)) -replace '-', '').ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
    $destinationLock.Position = 0
    if ($actualHash -cne [string]$entry.sha256) {
      throw 'The locked recovery launcher has the wrong hash.'
    }
    return [pscustomobject]@{
      path = $destination
      sha256 = [string]$entry.sha256
      stream = $destinationLock
    }
  } catch {
    if ($destinationLock) {
      $destinationLock.Dispose()
    }
    if ($createdDestination -and (Test-Path -LiteralPath $destination -PathType Leaf)) {
      try {
        Assert-PathHasNoReparsePointAncestors -Path $destination
        Assert-FinalPathContainedByRoot -Root $rootPath -Path $destination
        Assert-NoAlternateDataStreamsAtPath -Path $destination
        Remove-Item -LiteralPath $destination -Force
      } catch {
        # Preserve the original integrity or startup error; the next recovery remains fail-closed.
      }
    }
    throw
  } finally {
    Close-IntegrityHandles -Handles $sourceHandles
  }
}

function Remove-VerifiedRecoveryStartScript {
  param([string]$Root, [AllowNull()][object]$RecoveryStart)
  if ($null -eq $RecoveryStart) {
    return
  }
  $path = [System.IO.Path]::GetFullPath([string]$RecoveryStart.path)
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  try {
    if ($RecoveryStart.stream) {
      $RecoveryStart.stream.Dispose()
    }
  } finally {
    $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $path)).TrimEnd('\', '/')
    if (-not [string]::Equals($parent, $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'The recovery launcher cleanup path is outside the application root.'
    }
    Assert-PathHasNoReparsePointAncestors -Path $path
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $path
    if (Test-Path -LiteralPath $path) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'The recovery launcher cleanup path is no longer a file.'
      }
      Assert-NoAlternateDataStreamsAtPath -Path $path
      if (-not (Test-FileHashEquals -Path $path -ExpectedHash ([string]$RecoveryStart.sha256))) {
        throw 'The recovery launcher changed before cleanup.'
      }
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Start-RecoveredRuntime {
  param(
    [string]$Root,
    [string]$Endpoint,
    [int]$TimeoutSeconds,
    [AllowNull()]
    [string]$StartScriptPath
  )
  $startedAfterUtc = (Get-Date).ToUniversalTime()
  $launcher = $null
  try {
    $launcher = Start-App -Root $Root -StartScriptPath $StartScriptPath
    if (-not (Wait-AppHealth `
      -TimeoutSeconds $TimeoutSeconds `
      -Endpoint $Endpoint `
      -Root $Root `
      -LauncherProcess $launcher `
      -ExpectedProcessStartedAfterUtc $startedAfterUtc)) {
      throw 'The recovered runtime did not pass its stable health verification.'
    }
  } catch {
    $recoveryErrorRecord = $_
    $recoveryFailure = $_.Exception.Message
    $cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
    if ($launcher) {
      try {
        Stop-LauncherProcessTree -LauncherProcess $launcher
      } catch {
        [void]$cleanupFailures.Add("launcher tree cleanup failed: $($_.Exception.Message)")
      }
      $pidPath = Join-Path $Root 'app.pid'
      if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        try {
          Stop-AppProcesses `
            -Root $Root `
            -Endpoint $Endpoint `
            -AllowNotRunning `
            -AllowStaleOwnedJsonPidRecord `
            -RequireJsonRecord `
            -NotBeforeUtc $startedAfterUtc
        } catch {
          [void]$cleanupFailures.Add("verified recovery runtime cleanup failed: $($_.Exception.Message)")
        }
      }
    }
    if ($cleanupFailures.Count -gt 0) {
      throw "$recoveryFailure Recovery cleanup also failed: $($cleanupFailures -join '; ')"
    }
    throw $recoveryErrorRecord
  }
}

function Try-CompleteAlreadyRestoredHealthyRollback {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [string]$JournalPath,
    [object]$Transaction,
    [object]$Manifest,
    [string]$Endpoint,
    [int]$TimeoutSeconds,
    [switch]$PreserveCurrentReleaseBaseline,
    [object[]]$PreservedReleaseBaselineOverrides = @()
  )

  if ([string]$Transaction.phase -cne 'candidate-started') {
    return $null
  }
  $deploymentId = [string]$Transaction.deploymentId
  $currentDist = Join-Path $Root 'dist'
  $backupDist = Join-Path $Root "dist.rollback.$deploymentId"
  if (
    -not (Test-Path -LiteralPath $currentDist -PathType Container) -or
    (Test-Path -LiteralPath $backupDist)
  ) {
    return $null
  }
  $transactionId = [string]$Transaction.transactionId
  $recoveryArtifactRoot = Join-Path $Root ".hotfix-recovery-artifacts\$transactionId"
  $candidateArtifact = Join-Path $recoveryArtifactRoot 'dist-candidate'
  if (-not (Test-Path -LiteralPath $candidateArtifact -PathType Container)) {
    return $null
  }
  Assert-PathHasNoReparsePointAncestors -Path $candidateArtifact
  Assert-FinalPathContainedByRoot -Root $Root -Path $candidateArtifact
  Assert-NoReparsePointsOrAlternateDataStreams -Root $candidateArtifact

  $adoptionTimeoutSeconds = [Math]::Max(5, [Math]::Min($TimeoutSeconds, 15))
  if (-not (Wait-AppHealth `
    -TimeoutSeconds $adoptionTimeoutSeconds `
    -Endpoint $Endpoint `
    -Root $Root `
    -LauncherProcess $null)) {
    return $null
  }

  Assert-PreviousDistRuntime -Root $Root -Manifest $Manifest
  $backupRoot = Join-Path $Root ".hotfix-root-rollback.$deploymentId"
  $stageContainer = Join-Path $Root ".hotfix-stage\$deploymentId"
  $failedDist = Join-Path $Root "dist.failed.$deploymentId"
  $failedRoot = Join-Path $Root ".hotfix-root-failed.$deploymentId"
  $recoveryStart = New-VerifiedRecoveryStartScript `
    -Root $Root `
    -PackageRoot $PackageRoot `
    -Manifest $Manifest `
    -Transaction $Transaction
  try {
    if (-not $PreserveCurrentReleaseBaseline) {
      Restore-ReleaseFilesFromTransaction `
        -Root $Root `
        -BackupRoot $backupRoot `
        -Transaction $Transaction
    }
    $expectedReleaseBaseline = if ($PreserveCurrentReleaseBaseline) {
      @($PreservedReleaseBaselineOverrides)
    } else {
      @(Get-TransactionReleaseBaselineOverrides -Transaction $Transaction)
    }
    Assert-ServerNonDistBaseline `
      -Root $Root `
      -Manifest $Manifest `
      -ReleaseBaselineOverrides $expectedReleaseBaseline
    if (-not (Wait-AppHealth `
      -TimeoutSeconds $adoptionTimeoutSeconds `
      -Endpoint $Endpoint `
      -Root $Root `
      -LauncherProcess $null)) {
      throw 'The already-restored previous runtime changed while its rollback was being completed.'
    }
    foreach ($artifact in @(
      @{ path = $stageContainer; name = 'stage' },
      @{ path = $backupRoot; name = 'release-backup' },
      @{ path = $failedDist; name = 'previous-failed-dist' },
      @{ path = $failedRoot; name = 'previous-failed-release' }
    )) {
      Move-HotfixRecoveryArtifact `
        -Root $Root `
        -TransactionId $transactionId `
        -Source ([string]$artifact.path) `
        -Name ([string]$artifact.name)
    }
  } finally {
    Remove-VerifiedRecoveryStartScript -Root $Root -RecoveryStart $recoveryStart
  }
  $rolledBackTransaction = Set-HotfixTransactionPhase `
    -Path $JournalPath `
    -Transaction $Transaction `
    -Phase 'rolled-back'
  $script:reusablePreviousRuntimeBaselineProof = $true
  $script:replaceableClientBaselineProof = $true
  Write-Host '[INFO] Adopted the already-restored healthy previous runtime without restarting it.'
  return $rolledBackTransaction
}

function Rollback-UncommittedHotfixTransaction {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [string]$JournalPath,
    [object]$Transaction,
    [object]$Manifest,
    [string]$Endpoint,
    [int]$TimeoutSeconds,
    [switch]$PreparedRuntimeKnownUntouched,
    [switch]$PreserveCurrentReleaseBaseline,
    [object[]]$PreservedReleaseBaselineOverrides = @()
  )

  $deploymentId = [string]$Transaction.deploymentId
  $currentDist = Join-Path $Root 'dist'
  $backupDist = Join-Path $Root "dist.rollback.$deploymentId"
  $stageContainer = Join-Path $Root ".hotfix-stage\$deploymentId"
  $backupRoot = Join-Path $Root ".hotfix-root-rollback.$deploymentId"
  $failedDist = Join-Path $Root "dist.failed.$deploymentId"
  $failedRoot = Join-Path $Root ".hotfix-root-failed.$deploymentId"

  if (@('stage-intent', 'prepared') -contains [string]$Transaction.phase) {
    if (-not (Test-Path -LiteralPath $currentDist -PathType Container)) {
      throw 'A pre-switch hotfix transaction cannot be closed because the current runtime directory is missing.'
    }
    foreach ($unexpectedPath in @($backupDist, $backupRoot, $failedDist, $failedRoot)) {
      if (Test-Path -LiteralPath $unexpectedPath) {
        throw "A pre-switch hotfix transaction has an unexpected switch artifact: $unexpectedPath"
      }
    }
    Move-HotfixRecoveryArtifact `
      -Root $Root `
      -TransactionId ([string]$Transaction.transactionId) `
      -Source $stageContainer `
      -Name 'stage'
    if (-not $PreparedRuntimeKnownUntouched) {
      $preparedReleaseBaseline = if ($PreserveCurrentReleaseBaseline) {
        @($PreservedReleaseBaselineOverrides)
      } else {
        @(Get-TransactionReleaseBaselineOverrides -Transaction $Transaction)
      }
      Assert-ServerMutableBaseline `
        -Root $Root `
        -Manifest $Manifest `
        -ReleaseBaselineOverrides $preparedReleaseBaseline
    }
    return Set-HotfixTransactionPhase `
      -Path $JournalPath `
      -Transaction $Transaction `
      -Phase 'rolled-back'
  }

  $alreadyRestored = Try-CompleteAlreadyRestoredHealthyRollback `
    -Root $Root `
    -PackageRoot $PackageRoot `
    -JournalPath $JournalPath `
    -Transaction $Transaction `
    -Manifest $Manifest `
    -Endpoint $Endpoint `
    -TimeoutSeconds $TimeoutSeconds `
    -PreserveCurrentReleaseBaseline:$PreserveCurrentReleaseBaseline `
    -PreservedReleaseBaselineOverrides $PreservedReleaseBaselineOverrides
  if ($null -ne $alreadyRestored) {
    return $alreadyRestored
  }

  $recoveryStart = New-VerifiedRecoveryStartScript `
    -Root $Root `
    -PackageRoot $PackageRoot `
    -Manifest $Manifest `
    -Transaction $Transaction
  try {
    Stop-AppProcesses `
      -Root $Root `
      -Endpoint $Endpoint `
      -AllowNotRunning `
      -AllowStaleOwnedJsonPidRecord
    if (Test-Path -LiteralPath $backupDist) {
      if (Test-Path -LiteralPath $currentDist) {
        Move-HotfixRecoveryArtifact `
          -Root $Root `
          -TransactionId ([string]$Transaction.transactionId) `
          -Source $currentDist `
          -Name 'dist-candidate'
      }
      Move-ItemWithRetry -LiteralPath $backupDist -Destination $currentDist
    } else {
      Assert-PreviousDistRuntime -Root $Root -Manifest $Manifest
    }
    Invoke-HotfixFaultInjection -Phase 'after-rollback-dist-restored' -AppRoot $Root
    Start-RecoveredRuntime `
      -Root $Root `
      -Endpoint $Endpoint `
      -TimeoutSeconds $TimeoutSeconds `
      -StartScriptPath $recoveryStart.path
    if (-not $PreserveCurrentReleaseBaseline) {
      Restore-ReleaseFilesFromTransaction `
        -Root $Root `
        -BackupRoot $backupRoot `
        -Transaction $Transaction
    }
    foreach ($artifact in @(
      @{ path = $stageContainer; name = 'stage' },
      @{ path = $backupRoot; name = 'release-backup' },
      @{ path = $failedDist; name = 'previous-failed-dist' },
      @{ path = $failedRoot; name = 'previous-failed-release' }
    )) {
      Move-HotfixRecoveryArtifact `
        -Root $Root `
        -TransactionId ([string]$Transaction.transactionId) `
        -Source ([string]$artifact.path) `
        -Name ([string]$artifact.name)
    }
  } finally {
    Remove-VerifiedRecoveryStartScript -Root $Root -RecoveryStart $recoveryStart
  }
  $restoredReleaseBaseline = if ($PreserveCurrentReleaseBaseline) {
    @($PreservedReleaseBaselineOverrides)
  } else {
    @(Get-TransactionReleaseBaselineOverrides -Transaction $Transaction)
  }
  Assert-ServerMutableBaseline `
    -Root $Root `
    -Manifest $Manifest `
    -AllowReplaceableClientDrift `
    -ReleaseBaselineOverrides $restoredReleaseBaseline
  $script:reusablePreviousRuntimeBaselineProof = $true
  $script:replaceableClientBaselineProof = $true
  return Set-HotfixTransactionPhase `
    -Path $JournalPath `
    -Transaction $Transaction `
    -Phase 'rolled-back'
}

function Assert-CommittedRuntimeFiles {
  param([string]$Root, [object]$Transaction, [object]$Manifest)
  Assert-ManifestEntryIntegrity -Root $Root -Entries @($Manifest.payloadFiles)
  foreach ($entry in @($Transaction.releaseFiles)) {
    $targetPath = Resolve-AppRootTargetPath -Root $Root -RelativePath ([string]$entry.targetPath)
    if (-not (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$entry.candidateSha256))) {
      throw "A committed release target does not match the candidate hash: $($entry.targetPath)"
    }
  }
}

function Assert-PreviousInterruptedDeploymentRecoverable {
  param(
    [string]$Root,
    [object]$Transaction,
    [object]$Manifest
  )
  $phase = [string]$Transaction.phase
  $rollbackPhases = @(
    'stage-intent', 'prepared', 'runtime-stopped', 'dist-backup-intent', 'dist-backed-up',
    'candidate-dist-intent', 'candidate-dist-installed',
    'release-files-installed', 'candidate-started', 'candidate-healthy'
  )
  if ($rollbackPhases -cnotcontains $phase) {
    throw "The previous interrupted deployment cannot be safely recovered from phase '$phase' without its original package."
  }

  $deploymentId = [string]$Transaction.deploymentId
  if ($deploymentId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$') {
    throw 'The previous interrupted deployment identifier is not a safe path segment.'
  }
  $transactionId = [Guid]::Empty
  if (-not [Guid]::TryParse([string]$Transaction.transactionId, [ref]$transactionId)) {
    throw 'The previous interrupted deployment transaction identifier is invalid.'
  }

  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $currentDist = Join-Path $rootPath 'dist'
  $backupDist = Join-Path $rootPath "dist.rollback.$deploymentId"
  $backupRoot = Join-Path $rootPath ".hotfix-root-rollback.$deploymentId"
  $artifactPaths = @(
    (Join-Path $rootPath ".hotfix-stage\$deploymentId"),
    $backupDist,
    (Join-Path $rootPath "dist.failed.$deploymentId"),
    $backupRoot,
    (Join-Path $rootPath ".hotfix-root-failed.$deploymentId"),
    (Join-Path $rootPath ".hotfix-recovery-artifacts\$([string]$Transaction.transactionId)")
  )
  foreach ($artifactPath in $artifactPaths) {
    Assert-PathHasNoReparsePointAncestors -Path $artifactPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $artifactPath
    if (Test-Path -LiteralPath $artifactPath) {
      if (-not (Test-Path -LiteralPath $artifactPath -PathType Container)) {
        throw "A previous interrupted deployment artifact is not a directory: $artifactPath"
      }
      Assert-NoReparsePoints -Root $artifactPath
    }
  }
  if (Test-Path -LiteralPath $currentDist) {
    if (-not (Test-Path -LiteralPath $currentDist -PathType Container)) {
      throw 'The current runtime path is not a directory during previous deployment recovery.'
    }
    Assert-NoReparsePoints -Root $currentDist
  }

  try {
    if (Test-Path -LiteralPath $backupDist -PathType Container) {
      Assert-PreviousDistRuntime `
        -Root $rootPath `
        -Manifest $Manifest `
        -DistRoot $backupDist
    } elseif (Test-Path -LiteralPath $currentDist -PathType Container) {
      Assert-PreviousDistRuntime `
        -Root $rootPath `
        -Manifest $Manifest `
        -DistRoot $currentDist
    } else {
      throw 'Neither the rollback runtime nor the current runtime is available.'
    }
  } catch {
    throw "The previous interrupted deployment cannot be safely recovered because its server/shared baseline or replaceable frontend structure is invalid: $($_.Exception.Message)"
  }

  $currentManifestReleaseTargets = @{}
  foreach ($entry in @($Manifest.releaseFiles)) {
    $relativePath = [string]$entry.targetPath
    if ($currentManifestReleaseTargets.ContainsKey($relativePath)) {
      throw "The current package manifest contains a duplicate release target: $relativePath"
    }
    $currentManifestReleaseTargets[$relativePath] = $true
  }
  $allInterruptedReleaseTargetsRemainManaged = $true
  foreach ($entry in @($Transaction.releaseFiles)) {
    if (-not $currentManifestReleaseTargets.ContainsKey([string]$entry.targetPath)) {
      $allInterruptedReleaseTargetsRemainManaged = $false
      break
    }
  }
  if ($allInterruptedReleaseTargetsRemainManaged) {
    $releaseBaselineSnapshot = @(
      Get-ManagedReleaseBaselineSnapshot -Root $rootPath -Manifest $Manifest
    )
    Assert-ServerNonDistBaseline `
      -Root $rootPath `
      -Manifest $Manifest `
      -ReleaseBaselineOverrides $releaseBaselineSnapshot
    Write-Host '[INFO] Safely captured the current managed release-root state for one-step interrupted deployment takeover.'
    return [pscustomobject][ordered]@{
      preserveCurrentReleaseBaseline = $true
      releaseBaselineOverrides = $releaseBaselineSnapshot
    }
  }

  foreach ($entry in @($Transaction.releaseFiles)) {
    $relativePath = [string]$entry.targetPath
    $targetPath = Resolve-AppRootTargetPath -Root $rootPath -RelativePath $relativePath
    $backupPath = Resolve-AppRootTargetPath -Root $backupRoot -RelativePath $relativePath
    Assert-PathHasNoReparsePointAncestors -Path $targetPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $targetPath
    Assert-PathHasNoReparsePointAncestors -Path $backupPath
    Assert-FinalPathContainedByRoot -Root $rootPath -Path $backupPath

    $targetPresent = Test-Path -LiteralPath $targetPath
    $backupPresent = Test-Path -LiteralPath $backupPath
    if ($targetPresent -and -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
      throw "The previous interrupted deployment release target is not a file: $relativePath"
    }
    if ($backupPresent -and -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
      throw "The previous interrupted deployment release backup is not a file: $relativePath"
    }

    $baselineProven = $false
    if ($backupPresent) {
      if (
        -not [bool]$entry.baselineExisted -or
        -not (Test-FileHashEquals -Path $backupPath -ExpectedHash ([string]$entry.baselineSha256))
      ) {
        throw "The previous interrupted deployment release backup cannot prove its baseline: $relativePath"
      }
      $baselineProven = $true
    }
    if ($targetPresent) {
      if (
        [bool]$entry.baselineExisted -and
        (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$entry.baselineSha256))
      ) {
        $baselineProven = $true
      } elseif (-not (Test-FileHashEquals -Path $targetPath -ExpectedHash ([string]$entry.candidateSha256))) {
        if (Test-SemanticallyEquivalentConsumerReleaseMarker -Path $targetPath -RelativePath $relativePath) {
          $baselineProven = $true
          Write-Host "[INFO] Accepted semantically equivalent release marker during interrupted deployment recovery: $relativePath"
        } else {
          throw "The previous interrupted deployment release target matches neither its baseline nor candidate: $relativePath"
        }
      }
    }
    if ([bool]$entry.baselineExisted -and -not $baselineProven) {
      throw "The previous interrupted deployment has no proven release baseline: $relativePath"
    }
  }
  return [pscustomobject][ordered]@{
    preserveCurrentReleaseBaseline = $false
    releaseBaselineOverrides = @()
  }
}

function Remove-TerminalHotfixDeploymentArtifacts {
  param(
    [string]$Root,
    [object]$Transaction
  )
  $phase = [string]$Transaction.phase
  if (@('finalized', 'rolled-back') -cnotcontains $phase) {
    throw "Hotfix recovery artifacts cannot be removed from a non-terminal transaction phase: $phase"
  }
  $deploymentId = [string]$Transaction.deploymentId
  if ($deploymentId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$') {
    throw 'The terminal hotfix deployment identifier is not a safe path segment.'
  }
  $transactionId = [Guid]::Empty
  if (-not [Guid]::TryParse([string]$Transaction.transactionId, [ref]$transactionId)) {
    throw 'The terminal hotfix transaction identifier is invalid.'
  }
  $artifactPaths = @(
    (Join-Path $Root ".hotfix-stage\$deploymentId"),
    (Join-Path $Root "dist.rollback.$deploymentId"),
    (Join-Path $Root "dist.failed.$deploymentId"),
    (Join-Path $Root ".hotfix-root-rollback.$deploymentId"),
    (Join-Path $Root ".hotfix-root-failed.$deploymentId"),
    (Join-Path $Root ".hotfix-recovery-artifacts\$([string]$Transaction.transactionId)")
  )
  $cleanupClock = [System.Diagnostics.Stopwatch]::StartNew()
  $removedArtifactCount = 0
  foreach ($artifactPath in $artifactPaths) {
    Assert-PathHasNoReparsePointAncestors -Path $artifactPath
    Assert-FinalPathContainedByRoot -Root $Root -Path $artifactPath
    if (-not (Test-Path -LiteralPath $artifactPath)) {
      continue
    }
    if (Test-Path -LiteralPath $artifactPath -PathType Container) {
      # These are installer-owned, already-contained offline trees. Re-check
      # reparse points before deletion, but do not issue an ADS query for every
      # historical client chunk; ADS cannot redirect recursive deletion and the
      # per-file stream probe made large old bundles take many minutes to clean.
      Assert-NoReparsePoints -Root $artifactPath
      [System.IO.Directory]::Delete($artifactPath, $true)
    } elseif (Test-Path -LiteralPath $artifactPath -PathType Leaf) {
      Assert-NoAlternateDataStreamsAtPath -Path $artifactPath
      [System.IO.File]::Delete($artifactPath)
    } else {
      throw "A terminal hotfix recovery artifact has an unsupported filesystem type: $artifactPath"
    }
    $removedArtifactCount += 1
  }
  if ($removedArtifactCount -gt 0) {
    Write-Host "[INFO] Finalized runtime cleanup removed $removedArtifactCount artifact(s) in $($cleanupClock.ElapsedMilliseconds) ms."
  }
}

function Complete-CommittedHotfixTransaction {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [string]$JournalPath,
    [object]$Transaction,
    [object]$Manifest,
    [string]$Endpoint,
    [int]$TimeoutSeconds,
    [switch]$AlreadyHealthy,
    [AllowNull()]
    [object]$DependencyProofReport
  )
  Assert-CommittedRuntimeFiles -Root $Root -Transaction $Transaction -Manifest $Manifest
  if (-not $AlreadyHealthy -and -not (Wait-AppHealth `
    -TimeoutSeconds $TimeoutSeconds `
    -Endpoint $Endpoint `
    -Root $Root `
    -LauncherProcess $null)) {
    Stop-AppProcesses `
      -Root $Root `
      -Endpoint $Endpoint `
      -AllowNotRunning `
      -AllowStaleOwnedJsonPidRecord
    Start-RecoveredRuntime -Root $Root -Endpoint $Endpoint -TimeoutSeconds $TimeoutSeconds
  }
  if ($null -eq $DependencyProofReport) {
    $DependencyProofReport = Invoke-InstalledDependencyProofGate `
      -Root $Root `
      -PackageRoot $PackageRoot `
      -Manifest $Manifest
  } else {
    Assert-DependencyProofMatchesManifest `
      -Report $DependencyProofReport `
      -Manifest $Manifest
  }
  $installedReleaseReceiptPath = Join-Path $Root '.hotfix-installed-release.json'
  $installedReleaseReceipt = New-InstalledReleaseReceipt `
    -Root $Root `
    -Manifest $Manifest `
    -DependencyProofReport $DependencyProofReport
  $installedReleaseReceipt = Write-DurableInstalledReleaseReceipt `
    -Path $installedReleaseReceiptPath `
    -Receipt $installedReleaseReceipt
  $script:installedReleaseReceipt = $installedReleaseReceipt
  $script:installedReleaseReceiptActive = $true
  Write-DurableDependencyReadyStamp -Root $Root
  Invoke-HotfixFaultInjection `
    -Phase 'after-installed-release-receipt-written' `
    -AppRoot $Root
  $finalizedTransaction = Set-HotfixTransactionPhase `
    -Path $JournalPath `
    -Transaction $Transaction `
    -Phase 'finalized'
  Invoke-HotfixFaultInjection `
    -Phase 'after-finalized-written-before-cleanup' `
    -AppRoot $Root
  Remove-TerminalHotfixDeploymentArtifacts `
    -Root $Root `
    -Transaction $finalizedTransaction
  return $finalizedTransaction
}

function Close-ForeignCommittedHotfixTransaction {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [string]$JournalPath,
    [object]$Transaction,
    [object]$Manifest,
    [string]$Endpoint,
    [int]$TimeoutSeconds
  )

  if ([string]$Transaction.phase -cne 'committed') {
    throw 'Only a committed foreign hotfix transaction can be handed off.'
  }
  if (
    -not $script:installedReleaseReceiptActive -or
    $null -eq $script:installedReleaseReceipt -or
    [string]$script:installedReleaseReceipt.deploymentId -cne [string]$Transaction.deploymentId
  ) {
    throw 'The foreign committed hotfix transaction has no matching durable installed-release receipt.'
  }

  $receiptReleaseMap = @{}
  foreach ($entry in @($script:installedReleaseReceipt.releaseFiles)) {
    $targetPath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
    if ($receiptReleaseMap.ContainsKey($targetPath)) {
      throw "The installed-release receipt contains a duplicate root target: $targetPath"
    }
    $receiptReleaseMap[$targetPath] = [string]$entry.sha256
  }
  if ($receiptReleaseMap.Count -ne @($Transaction.releaseFiles).Count) {
    throw 'The foreign committed journal and installed-release receipt describe different root target sets.'
  }
  foreach ($entry in @($Transaction.releaseFiles)) {
    $targetPath = Assert-CanonicalRelativePath -RelativePath ([string]$entry.targetPath)
    if (
      -not $receiptReleaseMap.ContainsKey($targetPath) -or
      [string]$entry.candidateSha256 -cne [string]$receiptReleaseMap[$targetPath]
    ) {
      throw "The foreign committed journal is not bound to the installed-release receipt: $targetPath"
    }
  }

  Assert-InstalledReleaseReceiptState `
    -Root $Root `
    -Receipt $script:installedReleaseReceipt
  [void](Invoke-InstalledDependencyProofGate `
    -Root $Root `
    -PackageRoot $PackageRoot `
    -Manifest $Manifest `
    -CurrentReleaseOnly)
  if (-not (Wait-AppHealth `
    -TimeoutSeconds $TimeoutSeconds `
    -Endpoint $Endpoint `
    -Root $Root `
    -LauncherProcess $null)) {
    throw 'The foreign committed runtime did not pass health verification; automatic cross-package takeover was refused.'
  }

  $finalizedTransaction = Set-HotfixTransactionPhase `
    -Path $JournalPath `
    -Transaction $Transaction `
    -Phase 'finalized'
  Remove-TerminalHotfixDeploymentArtifacts `
    -Root $Root `
    -Transaction $finalizedTransaction
  Write-Host '[INFO] Proven foreign committed transaction was finalized from its durable receipt before installing the current package.'
  return $finalizedTransaction
}

function Recover-HotfixTransaction {
  param(
    [string]$Root,
    [string]$PackageRoot,
    [string]$JournalPath,
    [object]$Transaction,
    [object]$Manifest,
    [string]$Endpoint,
    [int]$TimeoutSeconds,
    [switch]$PreparedRuntimeKnownUntouched,
    [switch]$PreserveCurrentReleaseBaseline,
    [object[]]$PreservedReleaseBaselineOverrides = @()
  )
  if (@('committed', 'finalized') -contains [string]$Transaction.phase) {
    return Complete-CommittedHotfixTransaction `
      -Root $Root `
      -PackageRoot $PackageRoot `
      -JournalPath $JournalPath `
      -Transaction $Transaction `
      -Manifest $Manifest `
      -Endpoint $Endpoint `
      -TimeoutSeconds $TimeoutSeconds
  }
  if ([string]$Transaction.phase -eq 'rolled-back') {
    Assert-ServerMutableBaseline `
      -Root $Root `
      -Manifest $Manifest `
      -AllowReplaceableClientDrift `
      -ReleaseBaselineOverrides (Get-TransactionReleaseBaselineOverrides -Transaction $Transaction)
    $script:reusablePreviousRuntimeBaselineProof = $true
    $script:replaceableClientBaselineProof = $true
    return $Transaction
  }
  return Rollback-UncommittedHotfixTransaction `
    -Root $Root `
    -PackageRoot $PackageRoot `
    -JournalPath $JournalPath `
    -Transaction $Transaction `
    -Manifest $Manifest `
    -Endpoint $Endpoint `
    -TimeoutSeconds $TimeoutSeconds `
    -PreparedRuntimeKnownUntouched:$PreparedRuntimeKnownUntouched `
    -PreserveCurrentReleaseBaseline:$PreserveCurrentReleaseBaseline `
    -PreservedReleaseBaselineOverrides $PreservedReleaseBaselineOverrides
}

$packageRoot = $PSScriptRoot
$manifestPath = Join-Path $packageRoot 'hotfix-manifest.json'
$manifest = ([System.IO.File]::ReadAllText(
  $manifestPath,
  [System.Text.UTF8Encoding]::new($false)
)) | ConvertFrom-Json
$appRootPath = [System.IO.Path]::GetFullPath($AppRoot)
$deploymentClock = [System.Diagnostics.Stopwatch]::StartNew()
$script:reusablePreviousRuntimeBaselineProof = $false
$script:replaceableClientBaselineProof = $false
$script:adoptedReleaseBaselineOverrides = @()
$script:installedReleaseReceipt = $null
$script:installedReleaseReceiptActive = $false
$script:installedReleaseReceiptProven = $false
$script:priorInstalledReleaseReceiptRuntimeProofActive = $false
$script:priorInstalledReleaseReceiptRuntimeProofLogged = $false

if ($ValidateServerBaselineOnly) {
  Assert-HotfixManifestContract -PackageRoot $packageRoot -Manifest $manifest
  Assert-ServerRuntimeBaseline -Root $appRootPath -Manifest $manifest
  Assert-ServerDistBaseline -Root $appRootPath -Manifest $manifest
  [ordered]@{
    success = $true
    baselineFileCount = [int]$manifest.baselineFileCount
    payloadFileCount = [int]$manifest.baselinePayloadFileCount
    metadataOnlyFileCount = [int]$manifest.baselineMetadataOnlyFileCount
  } | ConvertTo-Json -Compress
  return
}

Assert-HotfixManifestContract -PackageRoot $packageRoot -Manifest $manifest
Assert-ExactPayloadFileSet -PackageRoot $packageRoot -Manifest $manifest
Assert-ExactSupportFileSet -PackageRoot $packageRoot -Manifest $manifest
Assert-ExactReleaseFileSet -PackageRoot $packageRoot -Manifest $manifest
Assert-ExactControlFileSet -PackageRoot $packageRoot -Manifest $manifest
Assert-ManifestEntryIntegrity -Root $packageRoot -Entries @($manifest.payloadFiles)
Assert-ManifestEntryIntegrity -Root $packageRoot -Entries @($manifest.supportFiles)
Assert-ManifestEntryIntegrity -Root $packageRoot -Entries @($manifest.releaseFiles)
Assert-ManifestEntryIntegrity -Root $packageRoot -Entries @($manifest.controlFiles)
Assert-NoReparsePointsOrAlternateDataStreams -Root $packageRoot
Write-Host "[INFO] Package integrity preflight completed in $($deploymentClock.ElapsedMilliseconds) ms."

foreach ($item in Get-ChildItem -LiteralPath $packageRoot -Force -Recurse) {
  $relative = Get-RelativeUnixPath -BasePath $packageRoot -FullPath $item.FullName
  Assert-SafePackagePath -RelativePath $relative
}

$deploymentId = [string]$manifest.packageId
$stageContainer = Join-Path $appRootPath ".hotfix-stage\$deploymentId"
$stageDist = Join-Path $stageContainer 'dist'
$stageReleaseRoot = Join-Path $stageContainer 'release-root'
$currentDist = Join-Path $appRootPath 'dist'
$backupDist = Join-Path $appRootPath "dist.rollback.$deploymentId"
$failedDist = Join-Path $appRootPath "dist.failed.$deploymentId"
$backupRoot = Join-Path $appRootPath ".hotfix-root-rollback.$deploymentId"
$failedRoot = Join-Path $appRootPath ".hotfix-root-failed.$deploymentId"
$maintenanceLockPath = Join-Path $appRootPath '.maintenance.lock'
$transactionJournalPath = Join-Path $appRootPath '.hotfix-transaction.json'
$installedReleaseReceiptPath = Join-Path $appRootPath '.hotfix-installed-release.json'
Assert-DeploymentPathTopology `
  -AppRoot $appRootPath `
  -PackageRoot $packageRoot `
  -DeploymentPaths @(
    $currentDist,
    $stageContainer,
    $backupDist,
    $failedDist,
    $backupRoot,
    $failedRoot,
    $maintenanceLockPath,
    $transactionJournalPath,
    $installedReleaseReceiptPath
  ) `
  -Manifest $manifest

$lifecycleLockStream = Open-LifecycleLock -Root $appRootPath
$runtimeSwitchStarted = $false
$deploymentSucceeded = $false
$transaction = $null
$existingTransaction = $null
$currentInvocationTransactionId = $null
$previousTerminalTransaction = $null
$previousInterruptedTransactionId = $null
$releaseFileStates = New-Object 'System.Collections.Generic.List[object]'
$replacementLauncher = $null
$postHealthDependencyProofReport = $null
$integrityHandles = $null
try {
  $script:installedReleaseReceipt = Read-StrictInstalledReleaseReceipt `
    -Path $installedReleaseReceiptPath `
    -ExpectedAppRoot $appRootPath
  if ($null -ne $script:installedReleaseReceipt) {
    if (Test-InstalledReleaseReceiptCompatibility `
      -Receipt $script:installedReleaseReceipt `
      -Manifest $manifest) {
      $script:installedReleaseReceiptActive = $true
    } else {
      Write-Host '[INFO] The installed-release receipt belongs to a different release tool or dependency tree; the explicit server baseline remains required.'
    }
  }
  $existingTransaction = Read-StrictHotfixTransaction `
    -Path $transactionJournalPath `
    -ExpectedAppRoot $appRootPath
  Resolve-HotfixMaintenanceOwner `
    -Path $maintenanceLockPath `
    -Transaction $existingTransaction `
    -AppRoot $appRootPath
  if ($existingTransaction) {
    if ([string]$existingTransaction.deploymentId -cne $deploymentId) {
      if (@('finalized', 'rolled-back') -cnotcontains [string]$existingTransaction.phase) {
        if ([string]$existingTransaction.phase -eq 'committed') {
          $existingTransaction = Close-ForeignCommittedHotfixTransaction `
            -Root $appRootPath `
            -PackageRoot $packageRoot `
            -JournalPath $transactionJournalPath `
            -Transaction $existingTransaction `
            -Manifest $manifest `
            -Endpoint $HealthEndpoint `
            -TimeoutSeconds $HealthTimeoutSeconds
          if (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf) {
            Remove-Item -LiteralPath $maintenanceLockPath -Force
          }
          Adopt-InstalledReleaseReceiptBaseline -Root $appRootPath -Manifest $manifest
          $previousTerminalTransaction = $existingTransaction
          Write-Host '[INFO] Closed the interrupted committed deployment by durable receipt; continuing with the current package.'
          $existingTransaction = $null
        } else {
          $previousInterruptedTransactionId = [string]$existingTransaction.transactionId
          $previousRecoveryPlan = Assert-PreviousInterruptedDeploymentRecoverable `
            -Root $appRootPath `
            -Transaction $existingTransaction `
            -Manifest $manifest
          $transaction = Recover-HotfixTransaction `
            -Root $appRootPath `
            -PackageRoot $packageRoot `
            -JournalPath $transactionJournalPath `
            -Transaction $existingTransaction `
            -Manifest $manifest `
            -Endpoint $HealthEndpoint `
            -TimeoutSeconds $HealthTimeoutSeconds `
          -PreparedRuntimeKnownUntouched:(@('stage-intent', 'prepared') -contains [string]$existingTransaction.phase) `
            -PreserveCurrentReleaseBaseline:([bool]$previousRecoveryPlan.preserveCurrentReleaseBaseline) `
            -PreservedReleaseBaselineOverrides @($previousRecoveryPlan.releaseBaselineOverrides)
          if ([string]$transaction.phase -cne 'rolled-back') {
            throw "The previous interrupted deployment recovered to an unexpected phase: $([string]$transaction.phase)"
          }
          Remove-TerminalHotfixDeploymentArtifacts `
            -Root $appRootPath `
            -Transaction $transaction
          if (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf) {
            Remove-Item -LiteralPath $maintenanceLockPath -Force
          }
          if (Test-Path -LiteralPath $transactionJournalPath -PathType Leaf) {
            Assert-PathHasNoReparsePointAncestors -Path $transactionJournalPath
            Assert-FinalPathContainedByRoot -Root $appRootPath -Path $transactionJournalPath
            Assert-NoAlternateDataStreamsAtPath -Path $transactionJournalPath
            Remove-Item -LiteralPath $transactionJournalPath -Force
          }
          if ($script:installedReleaseReceiptActive) {
            Adopt-InstalledReleaseReceiptBaseline -Root $appRootPath -Manifest $manifest
          } else {
            $script:reusablePreviousRuntimeBaselineProof = $true
            $script:replaceableClientBaselineProof = $true
            if ([bool]$previousRecoveryPlan.preserveCurrentReleaseBaseline) {
              $script:adoptedReleaseBaselineOverrides = @($previousRecoveryPlan.releaseBaselineOverrides)
            }
          }
          Write-Host '[INFO] Recovered and closed the interrupted previous deployment before installing the current package.'
          $existingTransaction = $null
          $transaction = $null
          $previousInterruptedTransactionId = $null
        }
      } else {
        $previousTerminalTransaction = $existingTransaction
        if ($script:installedReleaseReceiptActive) {
          Adopt-InstalledReleaseReceiptBaseline -Root $appRootPath -Manifest $manifest
        } else {
          Assert-ServerMutableBaseline `
            -Root $appRootPath `
            -Manifest $manifest `
            -AllowReplaceableClientDrift
          $terminalReleaseBaselineSnapshot = @(
            Get-ManagedReleaseBaselineSnapshot -Root $appRootPath -Manifest $manifest
          )
          $script:reusablePreviousRuntimeBaselineProof = $true
          $script:replaceableClientBaselineProof = $true
          $script:adoptedReleaseBaselineOverrides = @($terminalReleaseBaselineSnapshot)
        }
        Remove-TerminalHotfixDeploymentArtifacts `
          -Root $appRootPath `
          -Transaction $existingTransaction
        if (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf) {
          Remove-Item -LiteralPath $maintenanceLockPath -Force
        }
        if (Test-Path -LiteralPath $transactionJournalPath -PathType Leaf) {
          Assert-PathHasNoReparsePointAncestors -Path $transactionJournalPath
          Assert-FinalPathContainedByRoot -Root $appRootPath -Path $transactionJournalPath
          Assert-NoAlternateDataStreamsAtPath -Path $transactionJournalPath
          Remove-Item -LiteralPath $transactionJournalPath -Force
        }
        Write-Host '[INFO] Safely captured the current managed release-root state after terminal transaction cleanup.'
        Write-Host '[INFO] A proven terminal transaction from the previous deployment was cleaned.'
        $existingTransaction = $null
      }
    }
    if ($existingTransaction) {
      $transaction = Recover-HotfixTransaction `
        -Root $appRootPath `
        -PackageRoot $packageRoot `
        -JournalPath $transactionJournalPath `
        -Transaction $existingTransaction `
        -Manifest $manifest `
        -Endpoint $HealthEndpoint `
        -TimeoutSeconds $HealthTimeoutSeconds
      if ([string]$transaction.phase -eq 'finalized') {
        if (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf) {
          Remove-Item -LiteralPath $maintenanceLockPath -Force
        }
        Write-Host '[OK] This hotfix transaction was already committed, finalized, and healthy.'
        return
      }
      if ([string]$transaction.phase -eq 'rolled-back') {
        if (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf) {
          Remove-Item -LiteralPath $maintenanceLockPath -Force
        }
        if (Test-Path -LiteralPath $transactionJournalPath -PathType Leaf) {
          Remove-Item -LiteralPath $transactionJournalPath -Force
        }
        $transaction = $null
      }
    }
  }
  if ($script:installedReleaseReceiptActive -and -not $script:installedReleaseReceiptProven) {
    Adopt-InstalledReleaseReceiptBaseline -Root $appRootPath -Manifest $manifest
  }

  foreach ($path in @($stageContainer, $backupDist, $failedDist, $backupRoot, $failedRoot)) {
    if (Test-Path -LiteralPath $path) {
      throw "Deployment path already exists after transaction recovery: $path"
    }
  }

  $transaction = New-HotfixTransaction `
    -DeploymentId $deploymentId `
    -AppRoot $appRootPath `
    -Manifest $manifest `
    -ReleaseBaselineOverrides $script:adoptedReleaseBaselineOverrides
  $transaction = Write-DurableHotfixTransaction `
    -Path $transactionJournalPath `
    -Transaction $transaction
  $currentInvocationTransactionId = [string]$transaction.transactionId
  Write-DurableMaintenanceOwner `
    -Path $maintenanceLockPath `
    -Transaction $transaction `
    -AppRoot $appRootPath
  Invoke-HotfixFaultInjection -Phase 'after-stage-intent-written' -AppRoot $appRootPath

  New-Item -ItemType Directory -Path $stageContainer -Force | Out-Null
  Write-Host '[INFO] Staging the verified candidate runtime (single copy before downtime)...'
  $stagingClock = [System.Diagnostics.Stopwatch]::StartNew()
  Copy-Item -LiteralPath (Join-Path $packageRoot 'dist') -Destination $stageDist -Recurse
  Copy-Item -LiteralPath (Join-Path $packageRoot 'release-root') -Destination $stageReleaseRoot -Recurse
  $integrityHandles = Open-VerifiedStageIntegrityHandles `
    -StageRoot $stageContainer `
    -Manifest $manifest
  Assert-DeploymentPathTopology `
    -AppRoot $appRootPath `
    -PackageRoot $packageRoot `
    -DeploymentPaths @($currentDist, $stageContainer, $backupDist, $backupRoot) `
    -Manifest $manifest
  Write-Host "[INFO] Candidate staging and held integrity proof completed in $($stagingClock.ElapsedMilliseconds) ms."
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'prepared'
  Invoke-HotfixFaultInjection -Phase 'after-maintenance-created' -AppRoot $appRootPath

  $preStopDependencyProofReport = Invoke-InstalledDependencyProofGate `
    -Root $appRootPath `
    -PackageRoot $packageRoot `
    -Manifest $manifest
  Write-Host '[INFO] Installed production dependency tree proof passed before downtime.'

  Invoke-CandidateStartupConfigurationPreflight `
    -Root $appRootPath `
    -StageReleaseRoot $stageReleaseRoot

  Assert-ServerMutableBaseline `
    -Root $appRootPath `
    -Manifest $manifest `
    -AllowReplaceableClientDrift:([bool]$script:replaceableClientBaselineProof) `
    -ReleaseBaselineOverrides (Get-TransactionReleaseBaselineOverrides -Transaction $transaction)
  Write-Host '[INFO] Revalidated the complete strict runtime immediately before downtime.'
  Assert-RuntimeDirectoryRenameReady -Root $appRootPath
  Write-Host '[INFO] Runtime directory rename access is ready before downtime.'
  $currentRuntimeProcesses = @(Get-AppProcesses -Root $appRootPath)
  if ($currentRuntimeProcesses.Count -eq 0) {
    Assert-AppProcessesStopped -Root $appRootPath -Endpoint $HealthEndpoint
    Write-Host '[INFO] Current runtime was already stopped; proceeding with the verified baseline.'
  } else {
    $currentRuntimeHealthTimeoutSeconds = [Math]::Max(
      3,
      [Math]::Min($HealthTimeoutSeconds, 15)
    )
    if (-not (Wait-AppHealth `
      -TimeoutSeconds $currentRuntimeHealthTimeoutSeconds `
      -Endpoint $HealthEndpoint `
      -Root $appRootPath `
      -LauncherProcess $null)) {
      throw 'The current runtime changed or became unhealthy while the deployment lock was acquired. No files were changed.'
    }
    Write-Host "[INFO] Current runtime health proof completed in $($deploymentClock.ElapsedMilliseconds) ms."
  }
  $runtimeSwitchStarted = $true
  if ($currentRuntimeProcesses.Count -gt 0) {
    Stop-AppProcesses -Root $appRootPath -Endpoint $HealthEndpoint
  }
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'runtime-stopped'
  Invoke-HotfixFaultInjection -Phase 'after-runtime-stopped' -AppRoot $appRootPath
  Write-Host "[INFO] Current runtime stopped in $($deploymentClock.ElapsedMilliseconds) ms."

  Assert-ServerMutableBaseline `
    -Root $appRootPath `
    -Manifest $manifest `
    -AllowReplaceableClientDrift:([bool]$script:replaceableClientBaselineProof) `
    -ReleaseBaselineOverrides (Get-TransactionReleaseBaselineOverrides -Transaction $transaction)
  Write-Host '[INFO] Revalidated the complete strict runtime after the service stopped.'
  Assert-DeploymentPathTopology `
    -AppRoot $appRootPath `
    -PackageRoot $packageRoot `
    -DeploymentPaths @($currentDist, $stageContainer, $backupDist, $backupRoot) `
    -Manifest $manifest
  Assert-NoReparsePoints -Root $currentDist
  Assert-AppProcessesStopped -Root $appRootPath -Endpoint $HealthEndpoint
  Invoke-HotfixFaultInjection -Phase 'after-final-recheck-before-switch' -AppRoot $appRootPath
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'dist-backup-intent'
  Move-ItemWithRetry -LiteralPath $currentDist -Destination $backupDist
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'dist-backed-up'
  Invoke-HotfixFaultInjection -Phase 'after-dist-backup-moved' -AppRoot $appRootPath

  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'candidate-dist-intent'
  if (Test-Path -LiteralPath $currentDist) {
    throw 'The candidate runtime destination still exists after the previous runtime was backed up.'
  }
  $stageVolume = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($stageDist))
  $currentVolume = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($currentDist))
  if (-not [string]::Equals($stageVolume, $currentVolume, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The staged and current runtime directories are on different volumes; atomic directory switching is unavailable.'
  }
  $distIntegrityHandles = @(
    $integrityHandles |
      Where-Object { ([string]$_.relativePath).StartsWith('dist/', [System.StringComparison]::Ordinal) }
  )
  $releaseIntegrityHandles = @(
    $integrityHandles |
      Where-Object { -not ([string]$_.relativePath).StartsWith('dist/', [System.StringComparison]::Ordinal) }
  )
  if ($distIntegrityHandles.Count -eq 0 -or $releaseIntegrityHandles.Count -eq 0) {
    throw 'The staged integrity handle set cannot be partitioned for the atomic runtime switch.'
  }
  Close-IntegrityHandles -Handles $distIntegrityHandles
  $integrityHandles = $releaseIntegrityHandles
  $runtimeSwitchClock = [System.Diagnostics.Stopwatch]::StartNew()
  Move-ItemWithRetry -LiteralPath $stageDist -Destination $currentDist
  Write-Host "[INFO] Candidate runtime directory switched atomically in $($runtimeSwitchClock.ElapsedMilliseconds) ms."
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'candidate-dist-installed'
  Invoke-HotfixFaultInjection -Phase 'after-candidate-dist-installed' -AppRoot $appRootPath

  Switch-ReleaseFiles `
    -Root $appRootPath `
    -StagedRoot $stageReleaseRoot `
    -BackupRoot $backupRoot `
    -Manifest $manifest `
    -Transaction $transaction `
    -State $releaseFileStates `
    -IntegrityHandles $integrityHandles
  Close-IntegrityHandles -Handles $integrityHandles
  $integrityHandles = $null
  Write-Host "[INFO] Candidate release files installed in $($deploymentClock.ElapsedMilliseconds) ms."
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'release-files-installed'
  Invoke-HotfixFaultInjection -Phase 'after-release-files-installed' -AppRoot $appRootPath

  $replacementStartedAfterUtc = (Get-Date).ToUniversalTime()
  $replacementLauncher = Start-App `
    -Root $appRootPath `
    -DependencyProofFingerprint ([string]$manifest.dependencyInstalledPhysicalTreeFingerprint)
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'candidate-started'
  Invoke-HotfixFaultInjection -Phase 'after-candidate-started' -AppRoot $appRootPath
  if (-not (Wait-AppHealth `
    -TimeoutSeconds $HealthTimeoutSeconds `
    -Endpoint $HealthEndpoint `
    -Root $appRootPath `
    -LauncherProcess $replacementLauncher `
    -ExpectedProcessStartedAfterUtc $replacementStartedAfterUtc)) {
    throw 'The replacement runtime did not pass its health check.'
  }
  Write-Host "[INFO] Candidate runtime health proof completed in $($deploymentClock.ElapsedMilliseconds) ms."
  $postHealthDependencyProofReport = Invoke-InstalledDependencyProofGate `
    -Root $appRootPath `
    -PackageRoot $packageRoot `
    -Manifest $manifest
  Write-Host '[INFO] Installed production dependency tree remained unchanged after candidate startup.'
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'candidate-healthy'
  Invoke-HotfixFaultInjection -Phase 'after-candidate-healthy' -AppRoot $appRootPath
  $transaction = Set-HotfixTransactionPhase `
    -Path $transactionJournalPath `
    -Transaction $transaction `
    -Phase 'committed'
  Invoke-HotfixFaultInjection -Phase 'after-commit-written' -AppRoot $appRootPath
  $transaction = Complete-CommittedHotfixTransaction `
    -Root $appRootPath `
    -PackageRoot $packageRoot `
    -JournalPath $transactionJournalPath `
    -Transaction $transaction `
    -Manifest $manifest `
    -Endpoint $HealthEndpoint `
    -TimeoutSeconds $HealthTimeoutSeconds `
    -AlreadyHealthy `
    -DependencyProofReport $postHealthDependencyProofReport
  Write-Host "[INFO] Hotfix transaction finalized in $($deploymentClock.ElapsedMilliseconds) ms."
  Write-Host '[OK] Hotfix installed and healthy. Finalized recovery artifacts were removed.'
  $deploymentSucceeded = $true
} catch {
  $deploymentErrorRecord = $_
  $deploymentFailure = $_.Exception.Message
  if (-not $deploymentSucceeded) {
    Close-IntegrityHandles -Handles $integrityHandles
    $integrityHandles = $null
    try {
      $durableTransaction = Read-StrictHotfixTransaction `
        -Path $transactionJournalPath `
        -ExpectedAppRoot $appRootPath
    } catch {
      throw "Hotfix deployment failed: $deploymentFailure Recovery journal validation also failed: $($_.Exception.Message)"
    }
    if (-not $durableTransaction) {
      if ($runtimeSwitchStarted) {
        throw "Hotfix deployment failed: $deploymentFailure The runtime switch started without a recoverable durable transaction journal."
      }
      if (Test-Path -LiteralPath $stageContainer) {
        Assert-PathHasNoReparsePointAncestors -Path $stageContainer
        Assert-FinalPathContainedByRoot -Root $appRootPath -Path $stageContainer
        Remove-Item -LiteralPath $stageContainer -Recurse -Force
      }
      throw $deploymentErrorRecord
    }
    if ([string]$durableTransaction.deploymentId -cne $deploymentId) {
      $isPreviousInterruptedRecoveryFailure = (
        -not [string]::IsNullOrWhiteSpace($previousInterruptedTransactionId) -and
        [string]$durableTransaction.transactionId -ceq $previousInterruptedTransactionId
      )
      if ($isPreviousInterruptedRecoveryFailure) {
        throw $deploymentErrorRecord
      }
      $isUntouchedPreviousTerminalTransaction = (
        -not $runtimeSwitchStarted -and
        [string]::IsNullOrWhiteSpace($currentInvocationTransactionId) -and
        @('finalized', 'rolled-back') -contains [string]$durableTransaction.phase
      )
      if ($isUntouchedPreviousTerminalTransaction) {
        throw $deploymentErrorRecord
      }
      throw "Hotfix deployment failed: $deploymentFailure The durable rollback transaction belongs to a different deployment package."
    }
    $transaction = $durableTransaction
    $preparedRuntimeKnownUntouched = (
      -not $runtimeSwitchStarted -and
        (@('stage-intent', 'prepared') -contains [string]$transaction.phase) -and
      -not [string]::IsNullOrWhiteSpace($currentInvocationTransactionId) -and
      [string]$transaction.transactionId -ceq $currentInvocationTransactionId
    )
    try {
      if ($replacementLauncher -and [string]$transaction.phase -notin @('committed', 'finalized')) {
        Stop-LauncherProcessTree -LauncherProcess $replacementLauncher
      }
      $transaction = Recover-HotfixTransaction `
        -Root $appRootPath `
        -PackageRoot $packageRoot `
        -JournalPath $transactionJournalPath `
        -Transaction $transaction `
        -Manifest $manifest `
        -Endpoint $HealthEndpoint `
        -TimeoutSeconds $HealthTimeoutSeconds `
        -PreparedRuntimeKnownUntouched:$preparedRuntimeKnownUntouched
    } catch {
      throw "Hotfix deployment failed: $deploymentFailure Rollback also failed: $($_.Exception.Message)"
    }
    if ([string]$transaction.phase -eq 'rolled-back') {
      if ($preparedRuntimeKnownUntouched -or -not $runtimeSwitchStarted) {
        throw "Hotfix deployment failed before the runtime switch: $deploymentFailure The existing runtime was left untouched; no runtime health success is asserted."
      }
      throw "Hotfix deployment failed: $deploymentFailure The previous runtime was restored and passed its health check."
    }
    throw "Hotfix deployment failed after commit: $deploymentFailure The committed runtime was completed forward and passed its health check."
  }
  throw
} finally {
  try {
    Close-IntegrityHandles -Handles $integrityHandles
    $integrityHandles = $null
    if (
      $transaction -and
      @('rolled-back', 'finalized') -contains [string]$transaction.phase -and
      (Test-Path -LiteralPath $maintenanceLockPath -PathType Leaf)
    ) {
      Remove-Item -LiteralPath $maintenanceLockPath -Force
    }
  } finally {
    if ($lifecycleLockStream) {
      $lifecycleLockStream.Dispose()
    }
  }
}
'@
Set-Content -LiteralPath (Join-Path $stageRoot 'INSTALL-HOTFIX.ps1') -Value $installer -Encoding utf8

$readme = @(
  '# Nantong safe complete-runtime hotfix'
  ''
  "Package ID: $packageId"
  ''
  'This archive contains complete dist/server, dist/shared and dist/client runtime units.'
  'It also contains integrity-checked workflow migration and self-test tools under operations/.'
  'Do not merge-copy the packaged dist over an existing dist directory.'
  'It never contains .env, .runtime, logs, node_modules or certificates.'
  ''
  'If Windows marked a browser-downloaded archive, remove its Zone.Identifier before extracting:'
  "Unblock-File -LiteralPath '.\$packageId.zip'"
  ''
  'Extract the ZIP outside the application directory, then run as Administrator:'
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALL-HOTFIX.ps1 -AppRoot 'C:\ai\your-app-root'"
  ''
  'The installer validates the explicit server baseline, every release target and every payload file before stopping the service.'
  'A failed health check automatically restores both the previous dist directory and release-root files, then restarts the previous runtime.'
  ''
  'The archive never contains DingTalk credentials.'
  'Before enabling attendance automation on the server, set DINGTALK_ATTENDANCE_CLIENT_ID and DINGTALK_ATTENDANCE_CLIENT_SECRET in .env.local.'
  'Then verify the packaged CLI from the application root: node scripts/dingtalk-attendance-cli.mjs --self-test'
  ''
  'Before installation, run the shift-detail schema dry-run/apply/check from the application root.'
  'See operations/docs/runbooks/leave-workflow-multi-shift-substitute.md for the exact commands and historical-data procedure.'
) -join [Environment]::NewLine
Set-Content -LiteralPath (Join-Path $stageRoot 'README.md') -Value $readme -Encoding utf8

$controlFiles = @(
  foreach ($relativePath in @('INSTALL-HOTFIX.ps1', 'README.md')) {
    $fullPath = Join-Path $stageRoot $relativePath
    [ordered]@{
      path = $relativePath
      sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
      size = (Get-Item -LiteralPath $fullPath).Length
    }
  }
)
$manifest['controlFiles'] = $controlFiles
$installerControlEntry = @($controlFiles | Where-Object { [string]$_.path -ceq 'INSTALL-HOTFIX.ps1' })
if ($installerControlEntry.Count -ne 1) {
  throw 'The installer control-file identity is unavailable.'
}
$manifest['installerSha256'] = [string]$installerControlEntry[0].sha256
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stageRoot 'hotfix-manifest.json') -Encoding utf8

Remove-ZoneIdentifierStreamsFromArchiveStage -Root $stageRoot
Assert-ArchiveStageHasNoReparsePointsOrAlternateDataStreams -Root $stageRoot

$maxArchiveBytes = 64MB
$maxArchiveUncompressedBytes = 160MB
$archiveExpectedEntries = Get-ArchiveExpectedEntries -Root $stageRoot
Assert-ArchiveEvidenceBinding `
  -Entries $archiveExpectedEntries `
  -ExpectedBuildFingerprint $stageExpectedBuildFingerprint `
  -ClientReport $stageClientGateReport `
  -ExpectedClientFingerprint $stageActiveClientAssetFingerprint `
  -ExpectedPackageSha256 $candidatePackageSha256 `
  -ExpectedPackageLockSha256 $candidatePackageLockSha256 `
  -MaxActiveChunkCount $maxActiveClientChunkCount

$sourceSnapshotFingerprintAfter = Get-SourceSnapshotFingerprint `
  -Root $selectedBuildSourceRoot `
  -DirectoryAllowlist $buildDirectoryAllowlist `
  -FileAllowlist $buildFileAllowlist
if ($sourceSnapshotFingerprintBefore -cne $sourceSnapshotFingerprintAfter) {
  throw 'Source changed before formal candidate promotion.'
}
$workspaceDistFingerprintAfter = Get-DirectoryStateFingerprint -Path $workspaceDistPath
if ($workspaceDistFingerprintBefore -cne $workspaceDistFingerprintAfter) {
  throw 'Workspace dist changed during isolated hotfix packaging.'
}

Assert-ReleaseToolUnchanged `
  -Path $releaseToolPath `
  -ExpectedSha256 $releaseToolFingerprintAtStart `
  -ExpectedIdentity $releaseToolIdentityAtStart
Assert-ReleaseToolUnchanged `
  -Path $baselineGateToolPath `
  -ExpectedSha256 $baselineGateToolFingerprintAtStart `
  -ExpectedIdentity $baselineGateToolIdentityAtStart
[void](Assert-BaselineExportSourceUnchanged `
  -SourceExportRoot $baselineExportRootPath `
  -InitialExport $baselineExportInitial `
  -InitialManifestSha256 $baselineExportSourceManifestShaAtStart)
[void](Assert-BaselineExportManifest -ExportRoot $baselineSnapshotExportRoot)
Assert-BuildToolsUnchanged -BuildTools $buildTools

$partialZipOwnedIdentity = New-HotfixArchiveFromDirectory `
  -StageRoot $stageRoot `
  -ArchivePath $partialZipPath `
  -ExpectedEntries $archiveExpectedEntries
Assert-ReleaseToolUnchanged `
  -Path $releaseToolPath `
  -ExpectedSha256 $releaseToolFingerprintAtStart `
  -ExpectedIdentity $releaseToolIdentityAtStart
Assert-ReleaseToolUnchanged `
  -Path $baselineGateToolPath `
  -ExpectedSha256 $baselineGateToolFingerprintAtStart `
  -ExpectedIdentity $baselineGateToolIdentityAtStart
[void](Assert-BaselineExportSourceUnchanged `
  -SourceExportRoot $baselineExportRootPath `
  -InitialExport $baselineExportInitial `
  -InitialManifestSha256 $baselineExportSourceManifestShaAtStart)
[void](Assert-BaselineExportManifest -ExportRoot $baselineSnapshotExportRoot)
$prepareResult = Prepare-VerifiedHotfixArchive `
  -PartialZipPath $partialZipPath `
  -ExpectedPartialZipIdentity $partialZipOwnedIdentity `
  -ZipPath $zipPath `
  -PartialShaPath $partialShaPath `
  -ExpectedEntries $archiveExpectedEntries `
  -MaxArchiveBytes $maxArchiveBytes `
  -MaxUncompressedBytes $maxArchiveUncompressedBytes
$archiveHash = [string]$prepareResult.ArchiveHash
$publishedZipIdentity = $prepareResult.ZipIdentity
$partialShaOwnedIdentity = $prepareResult.PartialShaIdentity
$partialShaOwnedHash = [string]$prepareResult.PartialShaHash
} catch {
  $packagingFailure = $_
} finally {
  try {
    Remove-ProjectBuildSnapshot -Path $cleanBuildSnapshotRoot -ProjectRoot $projectRoot
  } catch {
    [void]$cleanupFailures.Add("project build snapshot: $($_.Exception.Message)")
  }
  try {
    Remove-CleanBuildWorkspace -Path $cleanBuildWorkspaceRoot
  } catch {
    [void]$cleanupFailures.Add("clean-build workspace: $($_.Exception.Message)")
  }
  try {
    Close-PackageOutputReservation -Reservation $outputReservation
  } catch {
    [void]$cleanupFailures.Add("package output reservation: $($_.Exception.Message)")
  }
  try {
    Close-WorkspacePackagingLease -Lease $workspacePackagingLease
  } catch {
    [void]$cleanupFailures.Add("workspace packaging lease: $($_.Exception.Message)")
  }
  if ($packagingFailure -or $cleanupFailures.Count -gt 0) {
    foreach ($entry in @(
      [pscustomobject]@{ Path = $partialShaPath; Identity = $partialShaOwnedIdentity; Label = 'partial SHA256 ready marker' },
      [pscustomobject]@{ Path = $zipPath; Identity = $partialZipOwnedIdentity; Label = 'prepared ZIP' },
      [pscustomobject]@{ Path = $partialZipPath; Identity = $partialZipOwnedIdentity; Label = 'partial ZIP' }
    )) {
      if (-not $entry.Identity) {
        continue
      }
      try {
        Remove-OwnedOutputFileWithRetry `
          -Path ([string]$entry.Path) `
          -ExpectedIdentity $entry.Identity `
          -Label ([string]$entry.Label)
      } catch {
        [void]$cleanupFailures.Add("$([string]$entry.Label): $($_.Exception.Message)")
      }
    }
  }
}

if ($packagingFailure) {
  if ($cleanupFailures.Count -gt 0) {
    try {
      Write-Warning "Packaging cleanup also failed: $($cleanupFailures -join '; ')" -WarningAction Continue
    } catch {
      # Never replace the packaging failure with a diagnostic failure.
    }
  }
  throw $packagingFailure
}
if ($cleanupFailures.Count -gt 0) {
  throw "Packaging cleanup also failed: $($cleanupFailures -join '; ')"
}

Publish-VerifiedReadyMarker `
  -PartialShaPath $partialShaPath `
  -ShaPath $shaPath `
  -ExpectedPartialShaIdentity $partialShaOwnedIdentity `
  -ExpectedPartialShaHash $partialShaOwnedHash `
  -ZipPath $zipPath `
  -ExpectedZipIdentity $publishedZipIdentity `
  -ExpectedArchiveHash $archiveHash `
  -ExpectedEntries $archiveExpectedEntries `
  -MaxArchiveBytes $maxArchiveBytes `
  -MaxUncompressedBytes $maxArchiveUncompressedBytes
$packageCompleted = $true
Write-Host "[OK] Package: $zipPath" -ErrorAction SilentlyContinue
Write-Host "[OK] SHA256: $archiveHash" -ErrorAction SilentlyContinue
Write-Host "[OK] Base fingerprint: $baseFingerprint" -ErrorAction SilentlyContinue
