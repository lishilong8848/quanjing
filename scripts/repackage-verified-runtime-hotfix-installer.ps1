[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceHotfixZip,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSourceSha256,
  [Parameter(Mandatory = $true)]
  [string]$InstallerGeneratorPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,
  [string]$RecoveryLauncherPath,
  [string]$BaselineRoot,
  [string]$OutputPackageId,
  [switch]$PreservePackageId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSBoundParameters.ContainsKey('OutputPackageId')) {
  $parsedOutputDate = [datetime]::MinValue
  if (
    $PreservePackageId -or
    $OutputPackageId -cnotmatch '^nantong-safe-full-runtime-hotfix-(\d{8}-\d{6})$' -or
    -not [datetime]::TryParseExact(
      $OutputPackageId.Substring('nantong-safe-full-runtime-hotfix-'.Length),
      'yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None, [ref]$parsedOutputDate
    )
  ) {
    throw 'OutputPackageId must be a valid ledger-compatible timestamp and cannot be combined with PreservePackageId.'
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StreamSha256 {
  param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($Stream)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Assert-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing or is not a file: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $Path"
  }
}

function Assert-NoReparsePointInPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $cursor = [System.IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Output path contains a reparse point: $cursor"
      }
    }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if (-not $parent) {
      break
    }
    $cursor = $parent.FullName
  }
}

function Assert-CanonicalRelativePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  if (
    [string]::IsNullOrWhiteSpace($RelativePath) -or
    $RelativePath.Contains('\') -or
    $RelativePath.Contains(':') -or
    [System.IO.Path]::IsPathRooted($RelativePath) -or
    $RelativePath.Normalize([System.Text.NormalizationForm]::FormC) -cne $RelativePath
  ) {
    throw "Non-canonical archive path: $RelativePath"
  }

  $reservedNames = @(
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  )
  foreach ($segment in @($RelativePath.Split('/'))) {
    if (
      [string]::IsNullOrEmpty($segment) -or
      $segment -eq '.' -or
      $segment -eq '..' -or
      $segment.EndsWith(' ') -or
      $segment.EndsWith('.') -or
      $segment -match '[<>"|?*]' -or
      @($segment.ToCharArray() | Where-Object { [int]$_ -lt 32 }).Count -gt 0
    ) {
      throw "Non-canonical archive path segment: $RelativePath"
    }
    $deviceName = $segment.Split('.')[0].ToUpperInvariant()
    if ($reservedNames -ccontains $deviceName) {
      throw "Reserved Windows device path is forbidden: $RelativePath"
    }
  }
}

function Assert-NonSensitiveArchivePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $forbiddenSegments = @(
    '.runtime', 'node_modules',
    'logs', 'certs', 'nantong-schedule-state', 'secrets'
  )
  $segments = @($RelativePath.Split('/'))
  foreach ($segment in $segments) {
    if (
      $forbiddenSegments -contains $segment -or
      $segment -match '(?i)^\.env(?:\..*)?$'
    ) {
      throw "Sensitive path is forbidden in a hotfix archive: $RelativePath"
    }
  }
  $leaf = $segments[$segments.Count - 1]
  if (
    $leaf -match '(?i)\.(map|log|pem|key|pfx|p12|jks|keystore|crt|cer|csr|der)$' -or
    @('id_rsa', 'id_ed25519', '.npmrc') -contains $leaf
  ) {
    throw "Sensitive file is forbidden in a hotfix archive: $RelativePath"
  }
}

function Get-SafeChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )
  Assert-CanonicalRelativePath -RelativePath $RelativePath
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $candidate = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  )
  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Archive path escapes the staging root: $RelativePath"
  }
  return $candidate
}

function Get-RequiredPropertyValue {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $properties = @($Object.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
  if ($properties.Count -ne 1) {
    throw "Required manifest property is missing or duplicated: $Name"
  }
  return $properties[0].Value
}

function Read-ZipEntryBytes {
  param(
    [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchiveEntry]$Entry,
    [int64]$MaximumBytes = 4MB
  )
  if ($Entry.Length -gt $MaximumBytes) {
    throw "Archive entry exceeds the allowed metadata size: $($Entry.FullName)"
  }
  $inputStream = $Entry.Open()
  $memory = New-Object System.IO.MemoryStream
  try {
    $inputStream.CopyTo($memory)
    return ,$memory.ToArray()
  } finally {
    $inputStream.Dispose()
    $memory.Dispose()
  }
}

function Get-ZipEntrySha256 {
  param([Parameter(Mandatory = $true)][System.IO.Compression.ZipArchiveEntry]$Entry)
  $inputStream = $Entry.Open()
  try {
    return Get-StreamSha256 -Stream $inputStream
  } finally {
    $inputStream.Dispose()
  }
}

function Get-ManifestRecords {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$Category
  )
  $value = Get-RequiredPropertyValue -Object $Manifest -Name $Category
  if ($null -eq $value) {
    throw "Manifest file category is null: $Category"
  }
  return @($value)
}

function Assert-ManifestEntryRecord {
  param(
    [Parameter(Mandatory = $true)][object]$Record,
    [Parameter(Mandatory = $true)][string]$Category
  )
  $pathValue = Get-RequiredPropertyValue -Object $Record -Name 'path'
  $sizeValue = Get-RequiredPropertyValue -Object $Record -Name 'size'
  $shaValue = Get-RequiredPropertyValue -Object $Record -Name 'sha256'
  if (-not ($pathValue -is [string])) {
    throw "Manifest path must be a string in $Category."
  }
  Assert-CanonicalRelativePath -RelativePath $pathValue
  Assert-NonSensitiveArchivePath -RelativePath $pathValue
  if (-not (($sizeValue -is [int]) -or ($sizeValue -is [long]))) {
    throw "Manifest size must be an integer for $pathValue."
  }
  if ([int64]$sizeValue -lt 0) {
    throw "Manifest size must not be negative for $pathValue."
  }
  if (-not ($shaValue -is [string]) -or $shaValue -cnotmatch '^[0-9a-f]{64}$') {
    throw "Manifest SHA-256 is not canonical for $pathValue."
  }
}

function Get-VerifiedHotfixArchiveData {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [string]$ExtractRoot,
    [string]$ExpectedPackageId
  )
  $archiveItem = Get-Item -LiteralPath $ArchivePath -Force
  if ($archiveItem.Length -gt 64MB) {
    throw "Hotfix archive exceeds the maximum compressed size: $ArchivePath"
  }

  $fileStream = New-Object System.IO.FileStream(
    $ArchivePath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  $archive = New-Object System.IO.Compression.ZipArchive(
    $fileStream,
    [System.IO.Compression.ZipArchiveMode]::Read,
    $false
  )
  try {
    $entriesByPath = [System.Collections.Generic.Dictionary[string, object]]::new(
      [System.StringComparer]::Ordinal
    )
    $casePaths = [System.Collections.Generic.Dictionary[string, string]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    [int64]$uncompressedBytes = 0
    foreach ($entry in @($archive.Entries)) {
      $relativePath = [string]$entry.FullName
      if ([string]::IsNullOrEmpty($entry.Name)) {
        throw "Directory entries are forbidden in a canonical hotfix ZIP: $relativePath"
      }
      Assert-CanonicalRelativePath -RelativePath $relativePath
      Assert-NonSensitiveArchivePath -RelativePath $relativePath
      if ($casePaths.ContainsKey($relativePath)) {
        throw "Duplicate or case-colliding archive path: $relativePath"
      }
      $unixFileType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
      if (
        $unixFileType -eq 0xA000 -or
        (($entry.ExternalAttributes -band 0x400) -ne 0)
      ) {
        throw "Archive links or reparse points are forbidden: $relativePath"
      }
      [void]$casePaths.Add($relativePath, $relativePath)
      [void]$entriesByPath.Add($relativePath, $entry)
      $uncompressedBytes += [int64]$entry.Length
      if ($uncompressedBytes -gt 160MB) {
        throw 'Hotfix archive exceeds the maximum uncompressed size.'
      }
    }

    if (-not $entriesByPath.ContainsKey('hotfix-manifest.json')) {
      throw 'The hotfix archive is missing hotfix-manifest.json.'
    }
    $manifestBytes = Read-ZipEntryBytes -Entry $entriesByPath['hotfix-manifest.json']
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $manifestText = $strictUtf8.GetString($manifestBytes)
    if ($manifestText.Length -gt 0 -and $manifestText[0] -eq [char]0xFEFF) {
      $manifestText = $manifestText.Substring(1)
    }
    try {
      $manifest = $manifestText | ConvertFrom-Json
    } catch {
      throw "The hotfix manifest is not valid JSON: $($_.Exception.Message)"
    }
    $schemaVersion = [int](Get-RequiredPropertyValue -Object $manifest -Name 'schemaVersion')
    if (@(5, 6) -cnotcontains $schemaVersion) {
      throw 'Only verified schemaVersion 5 or 6 runtime hotfix packages can be reused.'
    }
    $packageId = Get-RequiredPropertyValue -Object $manifest -Name 'packageId'
    if (-not ($packageId -is [string]) -or $packageId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') {
      throw 'The hotfix manifest packageId is invalid.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedPackageId) -and $packageId -cne $ExpectedPackageId) {
      throw "The hotfix manifest packageId does not match the expected output: $packageId"
    }

    $declaredPaths = [System.Collections.Generic.Dictionary[string, string]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($category in @('payloadFiles', 'releaseFiles', 'supportFiles', 'controlFiles')) {
      $records = @(Get-ManifestRecords -Manifest $manifest -Category $category)
      if ($category -ne 'controlFiles' -and $records.Count -eq 0) {
        throw "Manifest file category is unexpectedly empty: $category"
      }
      foreach ($record in $records) {
        Assert-ManifestEntryRecord -Record $record -Category $category
        $relativePath = [string]$record.path
        if ($relativePath -ceq 'hotfix-manifest.json' -or $declaredPaths.ContainsKey($relativePath)) {
          throw "Duplicate manifest archive path: $relativePath"
        }
        if (-not $entriesByPath.ContainsKey($relativePath)) {
          throw "Manifest-declared archive file is missing: $relativePath"
        }
        $zipEntry = [System.IO.Compression.ZipArchiveEntry]$entriesByPath[$relativePath]
        if ([int64]$zipEntry.Length -ne [int64]$record.size) {
          throw "Manifest size does not match archive bytes: $relativePath"
        }
        $actualSha256 = Get-ZipEntrySha256 -Entry $zipEntry
        if ($actualSha256 -cne [string]$record.sha256) {
          throw "Manifest SHA-256 does not match archive bytes: $relativePath"
        }
        [void]$declaredPaths.Add($relativePath, $category)
      }
    }

    $controlRecords = @(Get-ManifestRecords -Manifest $manifest -Category 'controlFiles')
    if (
      $controlRecords.Count -ne 2 -or
      @($controlRecords | Where-Object { $_.path -ceq 'INSTALL-HOTFIX.ps1' }).Count -ne 1 -or
      @($controlRecords | Where-Object { $_.path -ceq 'README.md' }).Count -ne 1
    ) {
      throw 'The controlFiles set must contain exactly INSTALL-HOTFIX.ps1 and README.md.'
    }
    if ($entriesByPath.Count -ne ($declaredPaths.Count + 1)) {
      throw 'The ZIP file set does not exactly match the manifest file set.'
    }
    foreach ($relativePath in @($entriesByPath.Keys)) {
      if ($relativePath -cne 'hotfix-manifest.json' -and -not $declaredPaths.ContainsKey($relativePath)) {
        throw "Unexpected archive file is not declared by the manifest: $relativePath"
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($ExtractRoot)) {
      [void][System.IO.Directory]::CreateDirectory($ExtractRoot)
      foreach ($relativePath in @($entriesByPath.Keys)) {
        $destinationPath = Get-SafeChildPath -Root $ExtractRoot -RelativePath $relativePath
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destinationPath))
        $inputStream = ([System.IO.Compression.ZipArchiveEntry]$entriesByPath[$relativePath]).Open()
        $outputStream = New-Object System.IO.FileStream(
          $destinationPath,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $inputStream.CopyTo($outputStream)
          $outputStream.Flush($true)
        } finally {
          $outputStream.Dispose()
          $inputStream.Dispose()
        }
      }
    }

    return [pscustomobject]@{
      Manifest = $manifest
      FileCount = $entriesByPath.Count
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-EmbeddedInstallerText {
  param([Parameter(Mandatory = $true)][string]$GeneratorPath)
  $generatorText = [System.IO.File]::ReadAllText($GeneratorPath)
  $pattern = "(?m)^\`$installer\s*=\s*@'\r?\n(?<body>[\s\S]*)\r?\n'@\r?\nSet-Content\s+-LiteralPath\s+\(Join-Path\s+\`$stageRoot\s+'INSTALL-HOTFIX\.ps1'\)"
  $matches = [System.Text.RegularExpressions.Regex]::Matches($generatorText, $pattern)
  if ($matches.Count -ne 1) {
    throw 'The current installer generator must contain exactly one extractable $installer here-string.'
  }
  return $matches[0].Groups['body'].Value + "`r`n"
}

function Assert-CompatibleBaselineDependencyFamily {
  param([object]$SourceManifest, [object]$BaselineManifest)
  $allowedPaths = @('package.json', 'package-lock.json', 'start.ps1', 'start.cmd')
  foreach ($inputManifest in @($SourceManifest, $BaselineManifest)) {
    $records = @($inputManifest.baseFiles)
    if ($records.Count -ne $allowedPaths.Count) {
      throw 'Baseline dependency metadata must contain the complete canonical base file set.'
    }
    foreach ($path in $allowedPaths) {
      $matches = @($records | Where-Object { $_.path -ceq $path })
      if ($matches.Count -ne 1 -or [string]$matches[0].sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Baseline dependency metadata is missing, duplicated or invalid.'
      }
    }
  }
  foreach ($path in @('package.json', 'package-lock.json')) {
    $sourceRecord = @($SourceManifest.baseFiles | Where-Object { $_.path -ceq $path })[0]
    $replacementRecord = @($BaselineManifest.baseFiles | Where-Object { $_.path -ceq $path })[0]
    if ([string]$sourceRecord.sha256 -cne [string]$replacementRecord.sha256) {
      throw "Baseline dependency metadata changed: $path"
    }
  }
}

function Get-ManifestInvariantJson {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [switch]$AllowRecoveryLauncherRefresh,
    [switch]$AllowBaselineRefresh
  )
  $copy = (($Manifest | ConvertTo-Json -Depth 50 -Compress) | ConvertFrom-Json)
  $copy.packageId = '<allowed-package-id>'
  $copy.createdAt = '<allowed-created-at>'
  $installRecords = @($copy.controlFiles | Where-Object { $_.path -ceq 'INSTALL-HOTFIX.ps1' })
  if ($installRecords.Count -ne 1) {
    throw 'The manifest must contain exactly one installer control record.'
  }
  $installRecords[0].size = -1
  $installRecords[0].sha256 = '<allowed-installer-sha256>'
  if ($AllowRecoveryLauncherRefresh) {
    $recoveryRecords = @(
      $copy.supportFiles |
        Where-Object { $_.path -ceq 'operations/deploy/hotfix-recovery-start.ps1' }
    )
    if ($recoveryRecords.Count -ne 1) {
      throw 'The manifest must contain exactly one recovery launcher support record.'
    }
    $recoveryRecords[0].size = -1
    $recoveryRecords[0].sha256 = '<allowed-recovery-launcher-sha256>'
  }
  if ($AllowBaselineRefresh) {
    foreach ($propertyName in @(
      'baseFingerprint',
      'baselineFingerprint',
      'baselineExportSchemaVersion',
      'baselineExportType',
      'baselineExportPlanAlgorithm',
      'baselineExportPlanFingerprint',
      'baselineFileCount',
      'baselinePayloadFileCount',
      'baselineMetadataOnlyFileCount',
      'baselineUncompressedBytes',
      'baseFiles',
      'distFingerprints',
      'serverBaselineFiles'
    )) {
      $copy.$propertyName = "<allowed-$propertyName>"
    }
    foreach ($record in @($copy.releaseFiles)) {
      $record.baselineExisted = $false
      $record.baselineSha256 = '<allowed-release-baseline-sha256>'
    }
  }
  return $copy | ConvertTo-Json -Depth 50 -Compress
}

function Get-VerifiedBaselineRefreshData {
  param(
    [Parameter(Mandatory = $true)][string]$ExportRoot,
    [Parameter(Mandatory = $true)][string]$ValidatorPath
  )

  $resolvedRoot = (Resolve-Path -LiteralPath $ExportRoot).Path
  Assert-NoReparsePointInPath -Path $resolvedRoot
  $manifestPath = Join-Path $resolvedRoot 'server-baseline-manifest.json'
  Assert-RegularFile -Path $manifestPath -Label 'Server baseline export manifest'
  $manifestSha256 = Get-FileSha256 -Path $manifestPath

  $validationOutput = & powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $ValidatorPath `
    -BaselineRoot $resolvedRoot `
    -ValidateBaselineOnly 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Server baseline validation failed: $($validationOutput -join [Environment]::NewLine)"
  }
  if ((Get-FileSha256 -Path $manifestPath) -cne $manifestSha256) {
    throw 'Server baseline export manifest changed during validation.'
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ([int](Get-RequiredPropertyValue -Object $manifest -Name 'schemaVersion') -ne 3) {
    throw 'Only verified schemaVersion 3 server baseline exports can be rebound.'
  }
  $files = @(
    @(Get-RequiredPropertyValue -Object $manifest -Name 'files') +
    @(Get-RequiredPropertyValue -Object $manifest -Name 'nonExportedRuntimeFiles') |
      Sort-Object { Get-Utf8PathSortKey -Path ([string]$_.path) }
  )
  if ($files.Count -ne [int](Get-RequiredPropertyValue -Object $manifest -Name 'baselineFileCount')) {
    throw 'The verified server baseline file count is inconsistent.'
  }

  return [pscustomobject]@{
    Root = $resolvedRoot
    ManifestPath = $manifestPath
    ManifestSha256 = $manifestSha256
    Manifest = $manifest
    Files = $files
  }
}

function Get-RelativeUnixPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$FullPath
  )
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $resolved = [System.IO.Path]::GetFullPath($FullPath)
  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staged path escapes its root: $FullPath"
  }
  return $resolved.Substring($prefix.Length).Replace('\', '/')
}

function Get-Utf8PathSortKey {
  param([Parameter(Mandatory = $true)][string]$Path)
  return ([System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($Path)) -replace '-', '')
}

function Assert-StagedPackageIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [Parameter(Mandatory = $true)][object]$Manifest
  )
  foreach ($item in @(Get-ChildItem -LiteralPath $StageRoot -Force -Recurse)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Staged package contains a reparse point: $($item.FullName)"
    }
  }
  $actualPaths = [System.Collections.Generic.Dictionary[string, object]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($file in @(Get-ChildItem -LiteralPath $StageRoot -Force -File -Recurse)) {
    $relativePath = Get-RelativeUnixPath -Root $StageRoot -FullPath $file.FullName
    Assert-CanonicalRelativePath -RelativePath $relativePath
    Assert-NonSensitiveArchivePath -RelativePath $relativePath
    if ($actualPaths.ContainsKey($relativePath)) {
      throw "Staged package contains a case-colliding file: $relativePath"
    }
    [void]$actualPaths.Add($relativePath, $file)
  }

  $declaredPaths = [System.Collections.Generic.Dictionary[string, object]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($category in @('payloadFiles', 'releaseFiles', 'supportFiles', 'controlFiles')) {
    foreach ($record in @(Get-ManifestRecords -Manifest $Manifest -Category $category)) {
      Assert-ManifestEntryRecord -Record $record -Category $category
      if ($declaredPaths.ContainsKey([string]$record.path)) {
        throw "Duplicate staged manifest path: $($record.path)"
      }
      [void]$declaredPaths.Add([string]$record.path, $record)
    }
  }
  if ($actualPaths.Count -ne ($declaredPaths.Count + 1) -or -not $actualPaths.ContainsKey('hotfix-manifest.json')) {
    throw 'The staged file set does not exactly match the manifest.'
  }
  foreach ($relativePath in @($declaredPaths.Keys)) {
    if (-not $actualPaths.ContainsKey($relativePath)) {
      throw "Staged manifest file is missing: $relativePath"
    }
    $record = $declaredPaths[$relativePath]
    $file = [System.IO.FileInfo]$actualPaths[$relativePath]
    if ([int64]$file.Length -ne [int64]$record.size) {
      throw "Staged file size does not match the manifest: $relativePath"
    }
    if ((Get-FileSha256 -Path $file.FullName) -cne [string]$record.sha256) {
      throw "Staged file SHA-256 does not match the manifest: $relativePath"
    }
  }
}

function New-CanonicalZipArchive {
  param(
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )
  $files = @(
    Get-ChildItem -LiteralPath $StageRoot -Force -File -Recurse |
      ForEach-Object {
        [pscustomobject]@{
          File = $_
          RelativePath = Get-RelativeUnixPath -Root $StageRoot -FullPath $_.FullName
        }
      } |
      Sort-Object { Get-Utf8PathSortKey -Path $_.RelativePath }
  )
  $stream = New-Object System.IO.FileStream(
    $ArchivePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  $archive = New-Object System.IO.Compression.ZipArchive(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    foreach ($item in $files) {
      Assert-CanonicalRelativePath -RelativePath $item.RelativePath
      $entry = $archive.CreateEntry(
        $item.RelativePath,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      $entry.LastWriteTime = [System.DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
      $inputStream = New-Object System.IO.FileStream(
        $item.File.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
      )
      $outputStream = $entry.Open()
      try {
        $inputStream.CopyTo($outputStream)
      } finally {
        $outputStream.Dispose()
        $inputStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

$toolPath = (Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
$sourceZipPath = (Resolve-Path -LiteralPath $SourceHotfixZip).Path
$sourceSidecarPath = $sourceZipPath + '.sha256'
$generatorPath = (Resolve-Path -LiteralPath $InstallerGeneratorPath).Path
$recoveryLauncherInputPath = $null
if ($PSBoundParameters.ContainsKey('RecoveryLauncherPath')) {
  if ([string]::IsNullOrWhiteSpace($RecoveryLauncherPath)) {
    throw 'RecoveryLauncherPath must not be empty when specified.'
  }
  $recoveryLauncherInputPath = (Resolve-Path -LiteralPath $RecoveryLauncherPath).Path
}
$baselineRefresh = $null
if ($PSBoundParameters.ContainsKey('BaselineRoot')) {
  if ([string]::IsNullOrWhiteSpace($BaselineRoot)) {
    throw 'BaselineRoot must not be empty when specified.'
  }
  $baselineRefresh = Get-VerifiedBaselineRefreshData `
    -ExportRoot $BaselineRoot `
    -ValidatorPath $generatorPath
}

Assert-RegularFile -Path $toolPath -Label 'Repackaging tool'
Assert-RegularFile -Path $sourceZipPath -Label 'Source hotfix ZIP'
Assert-RegularFile -Path $sourceSidecarPath -Label 'Source hotfix SHA-256 sidecar'
Assert-RegularFile -Path $generatorPath -Label 'Installer generator'
if ($null -ne $recoveryLauncherInputPath) {
  Assert-RegularFile -Path $recoveryLauncherInputPath -Label 'Recovery launcher'
}

if ($ExpectedSourceSha256 -cnotmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedSourceSha256 must contain exactly 64 hexadecimal characters.'
}
$expectedSourceHash = $ExpectedSourceSha256.ToLowerInvariant()
$sidecarText = [System.IO.File]::ReadAllText($sourceSidecarPath)
$sidecarMatch = [System.Text.RegularExpressions.Regex]::Match(
  $sidecarText,
  '\A([0-9A-Fa-f]{64})  ([^\r\n]+)\r?\n?\z'
)
if (-not $sidecarMatch.Success) {
  throw 'The source SHA-256 sidecar is not canonical.'
}
$sidecarHash = $sidecarMatch.Groups[1].Value.ToLowerInvariant()
$sidecarFileName = $sidecarMatch.Groups[2].Value
if ($sidecarFileName -cne [System.IO.Path]::GetFileName($sourceZipPath)) {
  throw 'The source SHA-256 sidecar names a different archive.'
}
if ($expectedSourceHash -cne $sidecarHash) {
  throw 'Expected source SHA-256 does not match the verified sidecar.'
}
$actualSourceHashAtStart = Get-FileSha256 -Path $sourceZipPath
if ($actualSourceHashAtStart -cne $expectedSourceHash) {
  throw 'The source hotfix ZIP does not match the expected SHA-256.'
}

$toolHashAtStart = Get-FileSha256 -Path $toolPath
$generatorHashAtStart = Get-FileSha256 -Path $generatorPath
$sidecarHashAtStart = Get-FileSha256 -Path $sourceSidecarPath
$recoveryLauncherHashAtStart = if ($null -ne $recoveryLauncherInputPath) {
  Get-FileSha256 -Path $recoveryLauncherInputPath
} else {
  $null
}
$installerText = Get-EmbeddedInstallerText -GeneratorPath $generatorPath
if ([string]::IsNullOrWhiteSpace($installerText)) {
  throw 'The extracted installer template is empty.'
}

$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$ownerToken = [System.Guid]::NewGuid().ToString('N')
$temporaryRoot = Join-Path $temporaryParent "nantong-verified-hotfix-repackage-$ownerToken"
$stageRoot = Join-Path $temporaryRoot 'stage'
$outputRootPath = $null
$completed = $false
$publishedZip = $false
$publishedSha = $false
$finalZipPath = $null
$finalShaPath = $null
$partialZipPath = $null
$partialShaPath = $null
$newArchiveHash = $null
try {
  [void][System.IO.Directory]::CreateDirectory($stageRoot)
  Assert-NoReparsePointInPath -Path $temporaryRoot
  $outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)

  $sourceData = Get-VerifiedHotfixArchiveData -ArchivePath $sourceZipPath -ExtractRoot $stageRoot
  $manifest = $sourceData.Manifest
  $allowRecoveryLauncherRefresh = $null -ne $recoveryLauncherInputPath
  $allowBaselineRefresh = $null -ne $baselineRefresh
  $sourceInvariant = Get-ManifestInvariantJson `
    -Manifest $manifest `
    -AllowRecoveryLauncherRefresh:$allowRecoveryLauncherRefresh `
    -AllowBaselineRefresh:$allowBaselineRefresh

  $packageId = if ($PSBoundParameters.ContainsKey('OutputPackageId')) {
    if ($OutputPackageId -ceq [string]$manifest.packageId) {
      throw 'OutputPackageId must differ from the source deployment identity.'
    }
    $OutputPackageId
  } elseif ($PreservePackageId) {
    [string]$manifest.packageId
  } else {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    "nantong-runtime-hotfix-$timestamp"
  }
  if ($packageId.Length -gt 64) {
    throw "Generated hotfix packageId exceeds the 64-character staging-path budget: $packageId"
  }
  $manifest.packageId = $packageId
  $manifest.createdAt = (Get-Date).ToString('o')

  if ($allowBaselineRefresh) {
    $baselineManifest = $baselineRefresh.Manifest
    $replacementBaseFingerprint = [string](Get-RequiredPropertyValue -Object $baselineManifest -Name 'baseFingerprint')
    Assert-CompatibleBaselineDependencyFamily -SourceManifest $manifest -BaselineManifest $baselineManifest
    $manifest.baseFingerprint = $replacementBaseFingerprint
    $manifest.baselineFingerprint = [string]$baselineManifest.baselineFingerprint
    $manifest.baselineExportSchemaVersion = [int]$baselineManifest.schemaVersion
    $manifest.baselineExportType = [string]$baselineManifest.exportType
    $manifest.baselineExportPlanAlgorithm = [string]$baselineManifest.exportPlanAlgorithm
    $manifest.baselineExportPlanFingerprint = [string]$baselineManifest.exportPlanFingerprint
    $manifest.baselineFileCount = [int]$baselineManifest.baselineFileCount
    $manifest.baselinePayloadFileCount = [int]$baselineManifest.fileCount
    $manifest.baselineMetadataOnlyFileCount = [int]$baselineManifest.nonExportedRuntimeFileCount
    $manifest.baselineUncompressedBytes = [int64]$baselineManifest.uncompressedBytes
    $manifest.baseFiles = @($baselineManifest.baseFiles)
    $manifest.distFingerprints = $baselineManifest.distFingerprints
    $manifest.serverBaselineFiles = @($baselineRefresh.Files)
    $baselineFilesByPath = [System.Collections.Generic.Dictionary[string, object]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($file in @($baselineRefresh.Files)) {
      [void]$baselineFilesByPath.Add([string]$file.path, $file)
    }
    foreach ($record in @($manifest.releaseFiles)) {
      $targetPath = [string]$record.targetPath
      if ($baselineFilesByPath.ContainsKey($targetPath)) {
        $record.baselineExisted = $true
        $record.baselineSha256 = [string]$baselineFilesByPath[$targetPath].sha256
      } else {
        $record.baselineExisted = $false
        $record.baselineSha256 = ''
      }
    }
  }

  $installerPath = Join-Path $stageRoot 'INSTALL-HOTFIX.ps1'
  $utf8WithBom = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($installerPath, $installerText, $utf8WithBom)
  $installerItem = Get-Item -LiteralPath $installerPath
  $installerSha256 = Get-FileSha256 -Path $installerPath
  $installerRecords = @($manifest.controlFiles | Where-Object { $_.path -ceq 'INSTALL-HOTFIX.ps1' })
  if ($installerRecords.Count -ne 1) {
    throw 'The source manifest has no unique installer control record.'
  }
  $installerRecords[0].size = [int64]$installerItem.Length
  $installerRecords[0].sha256 = $installerSha256

  if ($allowRecoveryLauncherRefresh) {
    $recoveryArchivePath = 'operations/deploy/hotfix-recovery-start.ps1'
    $recoveryRecords = @(
      $manifest.supportFiles |
        Where-Object { $_.path -ceq $recoveryArchivePath }
    )
    if ($recoveryRecords.Count -ne 1) {
      throw 'The source manifest has no unique recovery launcher support record.'
    }
    $stagedRecoveryPath = Get-SafeChildPath -Root $stageRoot -RelativePath $recoveryArchivePath
    [System.IO.File]::Copy($recoveryLauncherInputPath, $stagedRecoveryPath, $true)
    $recoveryItem = Get-Item -LiteralPath $stagedRecoveryPath
    $recoverySha256 = Get-FileSha256 -Path $stagedRecoveryPath
    if ($recoverySha256 -cne $recoveryLauncherHashAtStart) {
      throw 'The recovery launcher changed while it was being copied into the package.'
    }
    $recoveryRecords[0].size = [int64]$recoveryItem.Length
    $recoveryRecords[0].sha256 = $recoverySha256
  }

  if (
    (Get-ManifestInvariantJson `
      -Manifest $manifest `
      -AllowRecoveryLauncherRefresh:$allowRecoveryLauncherRefresh `
      -AllowBaselineRefresh:$allowBaselineRefresh) -cne $sourceInvariant
  ) {
    throw 'Manifest information outside the allowed installer and recovery launcher refresh fields changed.'
  }

  $manifestPath = Join-Path $stageRoot 'hotfix-manifest.json'
  $manifestJson = $manifest | ConvertTo-Json -Depth 50
  [System.IO.File]::WriteAllText($manifestPath, $manifestJson + "`r`n", $utf8WithBom)
  Assert-StagedPackageIntegrity -StageRoot $stageRoot -Manifest $manifest

  [void][System.IO.Directory]::CreateDirectory($outputRootPath)
  Assert-NoReparsePointInPath -Path $outputRootPath
  $finalZipPath = Join-Path $outputRootPath "$packageId.zip"
  $finalShaPath = $finalZipPath + '.sha256'
  $partialZipPath = Join-Path $outputRootPath "$packageId.$ownerToken.zip.partial"
  $partialShaPath = Join-Path $outputRootPath "$packageId.$ownerToken.sha256.partial"
  foreach ($path in @($finalZipPath, $finalShaPath, $partialZipPath, $partialShaPath)) {
    if (Test-Path -LiteralPath $path) {
      throw "Refusing to overwrite an existing package output: $path"
    }
  }

  New-CanonicalZipArchive -StageRoot $stageRoot -ArchivePath $partialZipPath
  $partialData = Get-VerifiedHotfixArchiveData `
    -ArchivePath $partialZipPath `
    -ExpectedPackageId $packageId
  if (
    (($partialData.Manifest | ConvertTo-Json -Depth 50 -Compress)) -cne
    (($manifest | ConvertTo-Json -Depth 50 -Compress))
  ) {
    throw 'The partial archive manifest changed during ZIP creation.'
  }
  $newArchiveHash = Get-FileSha256 -Path $partialZipPath
  $sidecarOutput = "$newArchiveHash  $packageId.zip`r`n"
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($partialShaPath, $sidecarOutput, $utf8WithoutBom)

  if ((Get-FileSha256 -Path $sourceZipPath) -cne $actualSourceHashAtStart) {
    throw 'The verified source hotfix ZIP changed while it was being reused.'
  }
  if ((Get-FileSha256 -Path $sourceSidecarPath) -cne $sidecarHashAtStart) {
    throw 'The verified source SHA-256 sidecar changed while it was being reused.'
  }
  if ((Get-FileSha256 -Path $generatorPath) -cne $generatorHashAtStart) {
    throw 'The installer generator changed while the package was being prepared.'
  }
  if (
    $allowRecoveryLauncherRefresh -and
    (Get-FileSha256 -Path $recoveryLauncherInputPath) -cne $recoveryLauncherHashAtStart
  ) {
    throw 'The recovery launcher changed while the package was being prepared.'
  }
  if (
    $allowBaselineRefresh -and
    (Get-FileSha256 -Path $baselineRefresh.ManifestPath) -cne $baselineRefresh.ManifestSha256
  ) {
    throw 'The verified server baseline manifest changed while the package was being prepared.'
  }
  if ((Get-FileSha256 -Path $toolPath) -cne $toolHashAtStart) {
    throw 'The repackaging tool changed while the package was being prepared.'
  }

  [System.IO.File]::Move($partialZipPath, $finalZipPath)
  $publishedZip = $true
  if ((Get-FileSha256 -Path $finalZipPath) -cne $newArchiveHash) {
    throw 'The promoted hotfix ZIP no longer matches its verified bytes.'
  }
  [System.IO.File]::Move($partialShaPath, $finalShaPath)
  $publishedSha = $true
  if ([System.IO.File]::ReadAllText($finalShaPath) -cne $sidecarOutput) {
    throw 'The promoted SHA-256 sidecar no longer matches its verified bytes.'
  }

  $completed = $true
  Write-Host "[OK] Package: $finalZipPath"
  Write-Host "[OK] SHA256: $newArchiveHash"
  Write-Host "[OK] Reused verified source: $actualSourceHashAtStart"
} finally {
  if (-not $completed) {
    foreach ($path in @($partialShaPath, $partialZipPath)) {
      if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) {
        Remove-Item -LiteralPath $path -Force
      }
    }
    if (
      $publishedSha -and
      -not [string]::IsNullOrWhiteSpace($finalShaPath) -and
      (Test-Path -LiteralPath $finalShaPath -PathType Leaf)
    ) {
      Remove-Item -LiteralPath $finalShaPath -Force
    }
    if (
      $publishedZip -and
      -not [string]::IsNullOrWhiteSpace($finalZipPath) -and
      (Test-Path -LiteralPath $finalZipPath -PathType Leaf) -and
      -not [string]::IsNullOrWhiteSpace($newArchiveHash) -and
      (Get-FileSha256 -Path $finalZipPath) -ceq $newArchiveHash
    ) {
      Remove-Item -LiteralPath $finalZipPath -Force
    }
  }
  if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
    $resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $temporaryPrefix = $temporaryParent + [System.IO.Path]::DirectorySeparatorChar
    if (
      $resolvedTemporaryRoot.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolvedTemporaryRoot) -ceq "nantong-verified-hotfix-repackage-$ownerToken"
    ) {
      Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    } else {
      throw "Refusing to clean an unexpected temporary path: $resolvedTemporaryRoot"
    }
  }
}
