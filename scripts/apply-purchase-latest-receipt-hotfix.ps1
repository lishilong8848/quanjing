param(
  [Parameter(Mandatory = $true)]
  [string]$AppRoot,
  [string]$HealthUrl = 'https://localhost:3001/api/access/session'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-SafeRelativePath {
  param([string]$Path)

  $normalized = ([string]$Path).Replace('\', '/')
  if (
    [string]::IsNullOrWhiteSpace($normalized) -or
    [IO.Path]::IsPathRooted($normalized) -or
    $normalized.StartsWith('/') -or
    $normalized.Contains(':') -or
    $normalized.Contains('//')
  ) {
    throw "Unsafe relative path: $Path"
  }

  $segments = @($normalized.Split('/'))
  if (@($segments | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0) {
    throw "Unsafe relative path: $Path"
  }
  return $normalized
}

function Assert-PathInside {
  param(
    [string]$Parent,
    [string]$Path
  )

  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $pathFull = [IO.Path]::GetFullPath($Path)
  $parentPrefix = $parentFull + [IO.Path]::DirectorySeparatorChar
  if (
    $pathFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
    !$pathFull.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to operate outside the approved root: $Path"
  }
}

function Assert-PathChainHasNoReparsePoint {
  param(
    [string]$Root,
    [string]$Path
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $pathFull = [IO.Path]::GetFullPath($Path)
  Assert-PathInside -Parent $rootFull -Path $pathFull

  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to use a reparse-point root: $rootFull"
  }

  $relative = $pathFull.Substring($rootFull.Length).TrimStart('\', '/')
  $current = $rootFull
  foreach ($segment in @($relative -split '[\\/]')) {
    if (!$segment) {
      continue
    }
    $current = Join-Path $current $segment
    if (!(Test-Path -LiteralPath $current)) {
      break
    }
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to traverse a reparse point: $current"
    }
  }
}

function Convert-ToFullChildPath {
  param(
    [string]$Root,
    [string]$RelativePath
  )

  $normalized = Assert-SafeRelativePath -Path $RelativePath
  $fullPath = [IO.Path]::GetFullPath(
    (Join-Path $Root $normalized.Replace('/', [IO.Path]::DirectorySeparatorChar))
  )
  Assert-PathInside -Parent $Root -Path $fullPath
  Assert-PathChainHasNoReparsePoint -Root $Root -Path $fullPath
  return $fullPath
}

function Assert-UniquePaths {
  param(
    [string[]]$Paths,
    [string]$Label
  )

  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in @($Paths)) {
    $normalized = Assert-SafeRelativePath -Path $path
    if (!$seen.Add($normalized)) {
      throw "$Label contains a duplicate path: $normalized"
    }
  }
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$Label
  )

  Assert-UniquePaths -Paths $Actual -Label $Label
  Assert-UniquePaths -Paths $Expected -Label "$Label expected values"
  if ($Actual.Count -ne $Expected.Count) {
    throw "$Label does not contain the exact expected paths."
  }
  $expectedSet = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $Expected) {
    [void]$expectedSet.Add((Assert-SafeRelativePath -Path $path))
  }
  foreach ($path in $Actual) {
    if (!$expectedSet.Contains((Assert-SafeRelativePath -Path $path))) {
      throw "$Label does not contain the exact expected paths."
    }
  }
}

function Assert-ManifestEntries {
  param(
    [object[]]$Entries,
    [string]$Label
  )

  if ($Entries.Count -eq 0) {
    throw "$Label must not be empty."
  }
  $paths = @()
  foreach ($entry in $Entries) {
    $path = Assert-SafeRelativePath -Path ([string]$entry.path)
    $hash = ([string]$entry.sha256).ToUpperInvariant()
    if ($hash -notmatch '^[0-9A-F]{64}$') {
      throw "$Label contains an invalid SHA256 value for $path."
    }
    $paths += $path
  }
  Assert-UniquePaths -Paths $paths -Label $Label
}

function Assert-ExactManifestEntries {
  param(
    [object[]]$Actual,
    [object[]]$Expected,
    [string]$Label
  )

  Assert-ManifestEntries -Entries $Actual -Label $Label
  Assert-ManifestEntries -Entries $Expected -Label "$Label expected values"
  Assert-ExactPathSet `
    -Actual @($Actual | ForEach-Object { [string]$_.path }) `
    -Expected @($Expected | ForEach-Object { [string]$_.path }) `
    -Label $Label

  $expectedHashes = @{}
  foreach ($entry in $Expected) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $expectedHashes[$relativePath] = ([string]$entry.sha256).ToUpperInvariant()
  }
  foreach ($entry in $Actual) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $actualHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($actualHash -cne $expectedHashes[$relativePath]) {
      throw "$Label hash mismatch: $relativePath"
    }
  }
}

function Get-RelativeFilePaths {
  param(
    [string]$Root,
    [string]$Prefix
  )

  if (!(Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Required directory is missing: $Root"
  }
  $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to enumerate a reparse-point root: $rootFull"
  }
  $reparsePoint = Get-ChildItem -LiteralPath $rootFull -Force -Recurse |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    Select-Object -First 1
  if ($reparsePoint) {
    throw "Refusing to enumerate a client reparse point: $($reparsePoint.FullName)"
  }

  $normalizedPrefix = (Assert-SafeRelativePath -Path $Prefix).TrimEnd('/')
  return @(
    Get-ChildItem -LiteralPath $rootFull -Force -File -Recurse |
      ForEach-Object {
        $localPath = $_.FullName.Substring($rootFull.Length).TrimStart('\', '/')
        $localPath = Assert-SafeRelativePath -Path $localPath
        Assert-SafeRelativePath -Path "$normalizedPrefix/$localPath"
      }
  )
}

function Get-Sha256 {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file is missing: $Path"
  }
  return (
    Get-FileHash -LiteralPath $Path -Algorithm SHA256
  ).Hash.ToUpperInvariant()
}

function Assert-EntriesMatchRoot {
  param(
    [string]$Root,
    [object[]]$Entries,
    [string]$Label
  )

  foreach ($entry in $Entries) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $fullPath = Convert-ToFullChildPath -Root $Root -RelativePath $relativePath
    $actualHash = Get-Sha256 -Path $fullPath
    $expectedHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($actualHash -cne $expectedHash) {
      throw "$Label hash mismatch: $relativePath"
    }
  }
}

function Assert-PackageFileSet {
  param(
    [string]$PackageRoot,
    [object[]]$ManifestFiles
  )

  $reparsePoint = Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    Select-Object -First 1
  if ($reparsePoint) {
    throw "Package contains a reparse point: $($reparsePoint.FullName)"
  }

  $actualPaths = @(
    Get-ChildItem -LiteralPath $PackageRoot -File -Recurse |
      ForEach-Object {
        Assert-SafeRelativePath -Path (
          $_.FullName.Substring($PackageRoot.Length).TrimStart('\', '/')
        )
      }
  )
  $expectedPaths = @(
    @($ManifestFiles | ForEach-Object { [string]$_.path }) +
      @('hotfix-manifest.json')
  )
  Assert-ExactPathSet `
    -Actual $actualPaths `
    -Expected $expectedPaths `
    -Label 'Package files'
}

function Assert-ExactClientSnapshot {
  param(
    [object[]]$ClientSnapshotFiles,
    [object[]]$ManifestFiles,
    [string[]]$ReplaceFiles,
    [string]$PackageRoot
  )

  Assert-ManifestEntries `
    -Entries $ClientSnapshotFiles `
    -Label 'clientSnapshotFiles'
  $snapshotPaths = @(
    $ClientSnapshotFiles | ForEach-Object {
      Assert-SafeRelativePath -Path ([string]$_.path)
    }
  )
  foreach ($relativePath in $snapshotPaths) {
    if (!$relativePath.StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw "clientSnapshotFiles contains a path outside dist/client/: $relativePath"
    }
  }
  if (@($snapshotPaths | Where-Object {
        $_.Equals(
          'dist/client/main.js',
          [StringComparison]::OrdinalIgnoreCase
        )
      }).Count -ne 1) {
    throw 'clientSnapshotFiles must contain dist/client/main.js.'
  }

  $manifestClientFiles = @(
    $ManifestFiles | Where-Object {
      (Assert-SafeRelativePath -Path ([string]$_.path)).StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  )
  $replaceClientPaths = @(
    $ReplaceFiles | Where-Object {
      (Assert-SafeRelativePath -Path $_).StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  )
  $packageClientRoot = Convert-ToFullChildPath `
    -Root $PackageRoot `
    -RelativePath 'dist/client'
  $packageClientPaths = @(
    Get-RelativeFilePaths `
      -Root $packageClientRoot `
      -Prefix 'dist/client'
  )

  Assert-ExactManifestEntries `
    -Actual $ClientSnapshotFiles `
    -Expected $manifestClientFiles `
    -Label 'clientSnapshotFiles manifest entries'
  Assert-ExactPathSet `
    -Actual $snapshotPaths `
    -Expected $replaceClientPaths `
    -Label 'clientSnapshotFiles replaceFiles paths'
  Assert-ExactPathSet `
    -Actual $snapshotPaths `
    -Expected $packageClientPaths `
    -Label 'clientSnapshotFiles package paths'
  Assert-EntriesMatchRoot `
    -Root $PackageRoot `
    -Entries $ClientSnapshotFiles `
    -Label 'clientSnapshotFiles payload'
}

function Get-ClientSnapshotEntries {
  param(
    [string]$TargetRoot,
    [string]$ClientRoot
  )

  $clientPaths = @(
    Get-RelativeFilePaths `
      -Root $ClientRoot `
      -Prefix 'dist/client'
  )
  if ($clientPaths.Count -eq 0) {
    throw 'Current dist/client directory must not be empty.'
  }
  if (@($clientPaths | Where-Object {
        $_.Equals(
          'dist/client/main.js',
          [StringComparison]::OrdinalIgnoreCase
        )
      }).Count -ne 1) {
    throw 'Current dist/client directory must contain dist/client/main.js.'
  }

  return @(
    $clientPaths | ForEach-Object {
      $relativePath = Assert-SafeRelativePath -Path $_
      $fullPath = Convert-ToFullChildPath `
        -Root $TargetRoot `
        -RelativePath $relativePath
      [pscustomobject]@{
        path = $relativePath
        sha256 = Get-Sha256 -Path $fullPath
      }
    }
  )
}

function Assert-ClientSnapshotAtDirectory {
  param(
    [string]$ClientRoot,
    [object[]]$Entries,
    [string]$Label
  )

  Assert-ManifestEntries -Entries $Entries -Label "$Label expected snapshot"
  $expectedPaths = @(
    $Entries | ForEach-Object {
      $relativePath = Assert-SafeRelativePath -Path ([string]$_.path)
      if (!$relativePath.StartsWith(
          'dist/client/',
          [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "$Label contains a path outside dist/client/: $relativePath"
      }
      $relativePath
    }
  )
  $actualPaths = @(
    Get-RelativeFilePaths `
      -Root $ClientRoot `
      -Prefix 'dist/client'
  )
  Assert-ExactPathSet `
    -Actual $actualPaths `
    -Expected $expectedPaths `
    -Label $Label

  $clientPrefixLength = 'dist/client/'.Length
  foreach ($entry in $Entries) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $clientRelativePath = $relativePath.Substring($clientPrefixLength)
    $fullPath = Convert-ToFullChildPath `
      -Root $ClientRoot `
      -RelativePath $clientRelativePath
    $actualHash = Get-Sha256 -Path $fullPath
    $expectedHash = ([string]$entry.sha256).ToUpperInvariant()
    if ($actualHash -cne $expectedHash) {
      throw "$Label hash mismatch: $relativePath"
    }
  }
}

function Copy-ClientSnapshotToDirectory {
  param(
    [string]$SourceRoot,
    [string]$DestinationClientRoot,
    [object[]]$Entries,
    [string]$Label
  )

  if (Test-Path -LiteralPath $DestinationClientRoot) {
    throw "$Label destination already exists: $DestinationClientRoot"
  }
  $destinationParent = Split-Path -Parent $DestinationClientRoot
  if (!(Test-Path -LiteralPath $destinationParent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  }
  New-Item -ItemType Directory -Path $DestinationClientRoot | Out-Null
  Assert-PathChainHasNoReparsePoint `
    -Root $destinationParent `
    -Path $DestinationClientRoot

  $clientPrefixLength = 'dist/client/'.Length
  foreach ($entry in $Entries) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    if (!$relativePath.StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw "$Label contains a path outside dist/client/: $relativePath"
    }
    $sourcePath = Convert-ToFullChildPath `
      -Root $SourceRoot `
      -RelativePath $relativePath
    $clientRelativePath = $relativePath.Substring($clientPrefixLength)
    $destinationPath = Convert-ToFullChildPath `
      -Root $DestinationClientRoot `
      -RelativePath $clientRelativePath
    $destinationFileParent = Split-Path -Parent $destinationPath
    New-Item `
      -ItemType Directory `
      -Force `
      -Path $destinationFileParent | Out-Null
    Assert-PathChainHasNoReparsePoint `
      -Root $DestinationClientRoot `
      -Path $destinationPath
    Copy-Item `
      -LiteralPath $sourcePath `
      -Destination $destinationPath `
      -Force
  }
  Assert-ClientSnapshotAtDirectory `
    -ClientRoot $DestinationClientRoot `
    -Entries $Entries `
    -Label $Label
}

function Assert-SameVolume {
  param(
    [string]$FirstPath,
    [string]$SecondPath,
    [string]$Label
  )

  $firstVolume = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($FirstPath))
  $secondVolume = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($SecondPath))
  if (!$firstVolume.Equals(
      $secondVolume,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "$Label paths must be on the same volume."
  }
}

function Remove-SafeDirectory {
  param(
    [string]$ApprovedRoot,
    [string]$Path
  )

  $approvedRootFull = [IO.Path]::GetFullPath($ApprovedRoot).TrimEnd('\', '/')
  $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  Assert-PathInside -Parent $approvedRootFull -Path $pathFull
  if (!(Test-Path -LiteralPath $pathFull)) {
    return
  }
  Assert-PathChainHasNoReparsePoint -Root $approvedRootFull -Path $pathFull
  if (!(Test-Path -LiteralPath $pathFull -PathType Container)) {
    throw "Refusing to recursively remove a non-directory path: $pathFull"
  }
  Remove-Item -LiteralPath $pathFull -Recurse -Force
}

function Test-CommandLineRunsMain {
  param(
    [string]$CommandLine,
    [string]$Root,
    [switch]$AllowRelative
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }
  $normalizedCommand = $CommandLine.Replace('\', '/')
  $absoluteMain = (
    Join-Path $Root 'dist/server/main.js'
  ).Replace('\', '/')
  if ($normalizedCommand.IndexOf(
      $absoluteMain,
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0) {
    return $true
  }
  return (
    $AllowRelative -and
    $normalizedCommand -match '(?i)(^|[\s"''])dist/server/main\.js([\s"'']|$)'
  )
}

function Get-AppNodePids {
  param([string]$Root)

  $ids = [Collections.Generic.HashSet[int]]::new()
  $pidFile = Join-Path $Root 'app.pid'
  $pidFileValue = 0
  if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($rawPid -match '^\d+$') {
      $pidFileValue = [int]$rawPid
    }
  }

  $nodeProcesses = @(
    Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction Stop
  )
  foreach ($process in $nodeProcesses) {
    $isPidFileProcess = [int]$process.ProcessId -eq $pidFileValue
    if (Test-CommandLineRunsMain `
        -CommandLine ([string]$process.CommandLine) `
        -Root $Root `
        -AllowRelative:$isPidFileProcess) {
      [void]$ids.Add([int]$process.ProcessId)
    }
  }
  return [int[]]@($ids | Sort-Object)
}

function Wait-ProcessesStopped {
  param(
    [int[]]$ProcessIds,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $remaining = @(
      $ProcessIds | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
      }
    )
    if ($remaining.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "Old application PID is still running: $($remaining -join ', ')"
}

function Invoke-AppScript {
  param(
    [string]$ScriptPath,
    [string]$Label
  )

  $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  & $powerShell `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $ScriptPath
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Get-VerifiedStartedProcess {
  param(
    [string]$Root,
    [int[]]$ForbiddenPids,
    [datetime]$NotBefore,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $pids = @(Get-AppNodePids -Root $Root)
    foreach ($candidatePid in $pids) {
      if ($candidatePid -in $ForbiddenPids) {
        continue
      }
      $process = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
      if ($process -and $process.StartTime -ge $NotBefore) {
        return $process
      }
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw 'The restarted application did not expose a new verified Node PID.'
}

function Assert-Health200 {
  param(
    [string]$Url,
    [string]$CurlPath
  )

  $statusCode = & $CurlPath @(
    '-k',
    '-sS',
    '--max-time',
    '15',
    '-o',
    'NUL',
    '-w',
    '%{http_code}',
    $Url
  ) 2>$null
  if ($LASTEXITCODE -ne 0 -or ([string]$statusCode).Trim() -cne '200') {
    throw 'Health check did not return HTTP 200.'
  }
}

function Assert-ClientAssetGraph {
  param(
    [string]$ClientRoot,
    [string]$VerifierPath,
    [string]$NodePath,
    [string]$Label
  )

  if (!(Test-Path -LiteralPath $ClientRoot -PathType Container)) {
    throw "$Label client directory is missing: $ClientRoot"
  }
  if (!(Test-Path -LiteralPath $VerifierPath -PathType Leaf)) {
    throw "$Label verifier is missing: verify-client-asset-graph.mjs"
  }
  $reportOutput = @(
    & $NodePath $VerifierPath --root $ClientRoot --json 2>&1
  )
  $exitCode = $LASTEXITCODE
  $reportText = @($reportOutput | ForEach-Object { [string]$_ }) -join (
    [Environment]::NewLine
  )
  if ($exitCode -ne 0) {
    throw "$Label client asset graph validation failed: $reportText"
  }
  try {
    $report = $reportText | ConvertFrom-Json
  } catch {
    throw "$Label client asset graph verifier returned invalid JSON."
  }
  if (!$report.ok -or @($report.missingAssets).Count -ne 0) {
    throw "$Label client asset graph is incomplete."
  }
}

function Assert-ServedClientMainHash {
  param(
    [Uri]$HealthUri,
    [string]$ExpectedSha256,
    [string]$CurlPath
  )

  $expectedHash = ([string]$ExpectedSha256).ToUpperInvariant()
  if ($expectedHash -notmatch '^[0-9A-F]{64}$') {
    throw 'Served client main expected SHA256 is invalid.'
  }
  $origin = $HealthUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
  $mainUrl = "$origin/main.js"
  $downloadPath = Join-Path ([IO.Path]::GetTempPath()) (
    'purchase-receipt-served-main-' + [Guid]::NewGuid().ToString('N') + '.js'
  )
  try {
    $statusCode = & $CurlPath @(
      '-k',
      '-sS',
      '--max-time',
      '15',
      '-o',
      $downloadPath,
      '-w',
      '%{http_code}',
      $mainUrl
    ) 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$statusCode).Trim() -cne '200') {
      throw 'Served client main did not return HTTP 200.'
    }
    $actualHash = Get-Sha256 -Path $downloadPath
    if ($actualHash -cne $expectedHash) {
      throw 'Served client main hash mismatch.'
    }
  } finally {
    if (Test-Path -LiteralPath $downloadPath -PathType Leaf) {
      Remove-Item -LiteralPath $downloadPath -Force
    }
  }
}

function Copy-EntriesToBackup {
  param(
    [string]$SourceRoot,
    [string]$BackupRoot,
    [object[]]$Entries
  )

  foreach ($entry in $Entries) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $sourcePath = Convert-ToFullChildPath `
      -Root $SourceRoot `
      -RelativePath $relativePath
    $backupPath = [IO.Path]::GetFullPath(
      (Join-Path $BackupRoot $relativePath.Replace(
          '/',
          [IO.Path]::DirectorySeparatorChar
        ))
    )
    Assert-PathInside -Parent $BackupRoot -Path $backupPath
    $backupParent = Split-Path -Parent $backupPath
    New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
    Assert-PathChainHasNoReparsePoint -Root $BackupRoot -Path $backupPath
    Copy-Item -LiteralPath $sourcePath -Destination $backupPath -Force
  }
}

function Restore-EntriesFromBackup {
  param(
    [string]$BackupRoot,
    [string]$TargetRoot,
    [object[]]$Entries
  )

  foreach ($entry in $Entries) {
    $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
    $backupPath = Convert-ToFullChildPath `
      -Root $BackupRoot `
      -RelativePath $relativePath
    $targetPath = Convert-ToFullChildPath `
      -Root $TargetRoot `
      -RelativePath $relativePath
    Copy-Item -LiteralPath $backupPath -Destination $targetPath -Force
  }
}

function Copy-PayloadToTarget {
  param(
    [string]$PackageRoot,
    [string]$TargetRoot,
    [string[]]$ReplaceFiles
  )

  foreach ($relativePathValue in $ReplaceFiles) {
    $relativePath = Assert-SafeRelativePath -Path $relativePathValue
    $payloadPath = Convert-ToFullChildPath `
      -Root $PackageRoot `
      -RelativePath $relativePath
    $targetPath = Convert-ToFullChildPath `
      -Root $TargetRoot `
      -RelativePath $relativePath
    Copy-Item -LiteralPath $payloadPath -Destination $targetPath -Force
  }
}

function Invoke-Rollback {
  param(
    [string]$StopScript,
    [string]$StartScript,
    [string]$BackupRoot,
    [string]$TargetRoot,
    [object[]]$Preconditions,
    [bool]$BackupComplete
  )

  Write-Host '[ROLLBACK] Restoring the previous runtime...' -ForegroundColor Yellow
  Invoke-AppScript -ScriptPath $StopScript -Label 'Rollback stop'
  if ($BackupComplete) {
    Restore-EntriesFromBackup `
      -BackupRoot $BackupRoot `
      -TargetRoot $TargetRoot `
      -Entries $Preconditions
    Assert-EntriesMatchRoot `
      -Root $TargetRoot `
      -Entries $Preconditions `
      -Label 'Rollback target'
  }
  Invoke-AppScript -ScriptPath $StartScript -Label 'Rollback start'
  Write-Host '[OK] Rollback completed; the previous runtime was restarted.' -ForegroundColor Green
}

function Invoke-CoherentClientRollback {
  param(
    [string]$StopScript,
    [string]$StartScript,
    [string]$BackupRoot,
    [string]$TargetRoot,
    [object[]]$ServerPreconditions,
    [bool]$BackupComplete,
    [string]$TargetClientRoot,
    [string]$RetiredClientRoot,
    [string]$FailedClientRoot,
    [string]$StagingRoot,
    [object[]]$PreviousClientSnapshot
  )

  Write-Host '[ROLLBACK] Restoring the previous runtime...' -ForegroundColor Yellow
  Invoke-AppScript -ScriptPath $StopScript -Label 'Rollback stop'
  Write-Host '[ROLLBACK] Failed runtime stopped.' -ForegroundColor Yellow
  if (!$BackupComplete) {
    throw 'The coherent client backup was not completed before deployment.'
  }

  $targetMatchesPrevious = $false
  if (Test-Path -LiteralPath $TargetClientRoot -PathType Container) {
    try {
      Assert-ClientSnapshotAtDirectory `
        -ClientRoot $TargetClientRoot `
        -Entries $PreviousClientSnapshot `
        -Label 'Rollback existing client'
      $targetMatchesPrevious = $true
    } catch {
      $targetMatchesPrevious = $false
    }
  }

  if (!$targetMatchesPrevious) {
    if (Test-Path -LiteralPath $TargetClientRoot) {
      if (Test-Path -LiteralPath $FailedClientRoot) {
        throw "Rollback failed-client destination already exists: $FailedClientRoot"
      }
      Assert-PathInside -Parent $StagingRoot -Path $FailedClientRoot
      Assert-PathChainHasNoReparsePoint `
        -Root $TargetRoot `
        -Path $TargetClientRoot
      Move-Item `
        -LiteralPath $TargetClientRoot `
        -Destination $FailedClientRoot
    }

    $retiredClientIsValid = $false
    if (Test-Path -LiteralPath $RetiredClientRoot -PathType Container) {
      try {
        Assert-ClientSnapshotAtDirectory `
          -ClientRoot $RetiredClientRoot `
          -Entries $PreviousClientSnapshot `
          -Label 'Rollback retired client'
        $retiredClientIsValid = $true
      } catch {
        $retiredClientIsValid = $false
      }
    }
    if ($retiredClientIsValid) {
      Move-Item `
        -LiteralPath $RetiredClientRoot `
        -Destination $TargetClientRoot
    } else {
      Copy-ClientSnapshotToDirectory `
        -SourceRoot $BackupRoot `
        -DestinationClientRoot $TargetClientRoot `
        -Entries $PreviousClientSnapshot `
        -Label 'Rollback client from backup'
    }
  }

  Restore-EntriesFromBackup `
    -BackupRoot $BackupRoot `
    -TargetRoot $TargetRoot `
    -Entries $ServerPreconditions
  Assert-EntriesMatchRoot `
    -Root $TargetRoot `
    -Entries $ServerPreconditions `
    -Label 'Rollback target'
  Assert-ClientSnapshotAtDirectory `
    -ClientRoot $TargetClientRoot `
    -Entries $PreviousClientSnapshot `
    -Label 'Rollback client'
  Write-Host '[ROLLBACK] Previous files restored and verified.' -ForegroundColor Yellow
  Invoke-AppScript -ScriptPath $StartScript -Label 'Rollback start'
  Write-Host '[OK] Rollback completed; the previous runtime was restarted.' -ForegroundColor Green
}

if (!(Test-Path -LiteralPath $AppRoot -PathType Container)) {
  throw "Application root was not found: $AppRoot"
}
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path.TrimEnd('\', '/')
$packageRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\', '/')

$manifestPath = Join-Path $packageRoot 'hotfix-manifest.json'
$stopScriptPath = Join-Path $AppRoot 'stop.ps1'
$startScriptPath = Join-Path $AppRoot 'start.ps1'
$mainRuntimePath = Join-Path $AppRoot 'dist/server/main.js'
foreach ($requiredPath in @(
    $manifestPath,
    $stopScriptPath,
    $startScriptPath,
    $mainRuntimePath
  )) {
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required deployment file is missing: $requiredPath"
  }
}
Assert-PathChainHasNoReparsePoint -Root $packageRoot -Path $manifestPath
foreach ($appPath in @($stopScriptPath, $startScriptPath, $mainRuntimePath)) {
  Assert-PathChainHasNoReparsePoint -Root $AppRoot -Path $appPath
}

$healthUri = $null
if (
  ![Uri]::TryCreate($HealthUrl, [UriKind]::Absolute, [ref]$healthUri) -or
  $healthUri.Scheme -notin @('http', 'https') -or
  $healthUri.UserInfo
) {
  throw 'HealthUrl must be an HTTP(S) URL without embedded credentials.'
}
$curlPath = (Get-Command curl.exe -ErrorAction Stop).Source

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
$legacyPackageType = 'purchase-receipt-session-recovery-overlay'
$coherentClientPackageType = 'purchase-receipt-coherent-client-overlay'
$manifestPackageType = [string]$manifest.packageType
if (
  [int]$manifest.schemaVersion -ne 2 -or
  [string]::IsNullOrWhiteSpace([string]$manifest.package) -or
  $manifestPackageType -cnotin @(
    $legacyPackageType,
    $coherentClientPackageType
  )
) {
  throw 'Hotfix manifest identity is invalid.'
}
$isCoherentClientOverlay = $manifestPackageType -ceq $coherentClientPackageType
if (
  $manifest.serviceRestartRequired -isnot [bool] -or
  !$manifest.serviceRestartRequired
) {
  throw 'Hotfix manifest must require a service restart.'
}
if ($isCoherentClientOverlay) {
  if ([string]$manifest.deploymentMode -cne 'coherent-client-overlay') {
    throw 'Coherent client hotfix deployment mode must be coherent-client-overlay.'
  }
} elseif ([string]$manifest.deploymentMode -cne 'overlay-files') {
  throw 'Hotfix manifest deployment mode must be overlay-files.'
}

$manifestFiles = @($manifest.files)
$targetPreconditions = @($manifest.targetPreconditions)
$preservedFiles = @($manifest.preservedFiles)
$manifestPropertyNames = @($manifest.PSObject.Properties.Name)
$clientSnapshotFiles = @()
if ($isCoherentClientOverlay) {
  if ($manifestPropertyNames -notcontains 'clientSnapshotFiles') {
    throw 'Coherent client hotfix manifest must contain clientSnapshotFiles.'
  }
  $clientSnapshotFiles = @($manifest.clientSnapshotFiles)
}
if ($manifestPropertyNames -contains 'replaceDirectories') {
  throw 'Directory replacement is forbidden; replaceDirectories must be absent.'
}
$replaceFiles = @(
  $manifest.replaceFiles | ForEach-Object {
    Assert-SafeRelativePath -Path ([string]$_)
  }
)
if ($replaceFiles.Count -eq 0) {
  throw 'replaceFiles must not be empty.'
}
Assert-ManifestEntries -Entries $manifestFiles -Label 'Manifest files'
Assert-ManifestEntries `
  -Entries $targetPreconditions `
  -Label 'Target preconditions'
if ($preservedFiles.Count -eq 0) {
  throw 'Preserved files must not be empty.'
}
Assert-ManifestEntries -Entries $preservedFiles -Label 'Preserved files'
Assert-UniquePaths -Paths $replaceFiles -Label 'replaceFiles'

foreach ($entry in $manifestFiles) {
  $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
  if (
    $relativePath -match '(^|/)(\.env[^/]*|node_modules|data|logs|certs|\.runtime)(/|$)' -or
    [IO.Path]::GetExtension($relativePath) -in @(
      '.map',
      '.ts',
      '.tsx',
      '.log',
      '.pem',
      '.key',
      '.pfx',
      '.p12'
    )
  ) {
    throw "Manifest contains a forbidden payload path: $relativePath"
  }
}
foreach ($entry in $targetPreconditions) {
  $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
  $isApprovedClientRuntime = if ($isCoherentClientOverlay) {
    $false
  } else {
    $relativePath.Equals(
      'dist/client/main.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  $isServerJavaScript = (
    $relativePath.StartsWith(
      'dist/server/',
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    [IO.Path]::GetExtension($relativePath).Equals(
      '.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  )
  if (!$isApprovedClientRuntime -and !$isServerJavaScript) {
    throw "Target precondition is outside the approved runtime scope: $relativePath"
  }
}
foreach ($entry in $preservedFiles) {
  $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
  $isApprovedPreservedFile = if ($isCoherentClientOverlay) {
    $relativePath.StartsWith(
      'dist/server/',
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    [IO.Path]::GetExtension($relativePath).Equals(
      '.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  } else {
    $relativePath.StartsWith(
      'dist/client/chunks/',
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    [IO.Path]::GetExtension($relativePath).Equals(
      '.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  if (!$isApprovedPreservedFile) {
    throw "Preserved file is outside the approved client chunk scope: $relativePath"
  }
}

$preconditionPaths = @(
  $targetPreconditions | ForEach-Object { [string]$_.path }
)
$preconditionPathSet = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($relativePath in $preconditionPaths) {
  [void]$preconditionPathSet.Add(
    (Assert-SafeRelativePath -Path $relativePath)
  )
}
foreach ($relativePath in $replaceFiles) {
  $isCoherentClientPath = (
    $isCoherentClientOverlay -and
    $relativePath.StartsWith(
      'dist/client/',
      [StringComparison]::OrdinalIgnoreCase
    )
  )
  if (!$isCoherentClientPath -and !$preconditionPathSet.Contains($relativePath)) {
    throw "replaceFiles path has no target precondition: $relativePath"
  }
}

$manifestPathSet = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($entry in $manifestFiles) {
  [void]$manifestPathSet.Add((Assert-SafeRelativePath -Path ([string]$entry.path)))
}
foreach ($relativePath in $replaceFiles) {
  if (!$manifestPathSet.Contains($relativePath)) {
    throw "replaceFiles path is absent from manifest files: $relativePath"
  }
  $isApprovedClientReplacement = if ($isCoherentClientOverlay) {
    $relativePath.StartsWith(
      'dist/client/',
      [StringComparison]::OrdinalIgnoreCase
    )
  } else {
    $relativePath.Equals(
      'dist/client/main.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  $isCompiledServerJavaScript = (
    $relativePath.StartsWith(
      'dist/server/',
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    [IO.Path]::GetExtension($relativePath).Equals(
      '.js',
      [StringComparison]::OrdinalIgnoreCase
    )
  )
  if (!$isApprovedClientReplacement -and !$isCompiledServerJavaScript) {
    throw "replaceFiles may contain only dist/client/main.js or compiled dist/server JavaScript: $relativePath"
  }
}
$replaceSet = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($relativePath in $replaceFiles) {
  [void]$replaceSet.Add($relativePath)
}
foreach ($entry in $preservedFiles) {
  $relativePath = Assert-SafeRelativePath -Path ([string]$entry.path)
  if ($replaceSet.Contains($relativePath)) {
    throw "A preserved path cannot also be replaced: $relativePath"
  }
}
$replacementPreconditions = @(
  $targetPreconditions | Where-Object {
    $replaceSet.Contains((Assert-SafeRelativePath -Path ([string]$_.path)))
  }
)
$replacementPreconditionPaths = if ($isCoherentClientOverlay) {
  @(
    $replaceFiles | Where-Object {
      !$_.StartsWith(
        'dist/client/',
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  )
} else {
  @($replaceFiles)
}
Assert-ExactPathSet `
  -Actual @($replacementPreconditions | ForEach-Object { [string]$_.path }) `
  -Expected $replacementPreconditionPaths `
  -Label 'replaceFiles target preconditions'

$verifierPath = ''
$nodePath = ''
$clientMainHash = ''
if ($isCoherentClientOverlay) {
  $verifierRelativePath = 'verify-client-asset-graph.mjs'
  if (!$manifestPathSet.Contains($verifierRelativePath)) {
    throw 'Coherent client payload must include verify-client-asset-graph.mjs.'
  }
  $verifierPath = Convert-ToFullChildPath `
    -Root $packageRoot `
    -RelativePath $verifierRelativePath
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $clientMainEntries = @(
    $clientSnapshotFiles | Where-Object {
      (Assert-SafeRelativePath -Path ([string]$_.path)).Equals(
        'dist/client/main.js',
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  )
  if ($clientMainEntries.Count -ne 1) {
    throw 'clientSnapshotFiles must contain exactly one dist/client/main.js entry.'
  }
  $clientMainHash = ([string]$clientMainEntries[0].sha256).ToUpperInvariant()
}

Assert-PackageFileSet `
  -PackageRoot $packageRoot `
  -ManifestFiles $manifestFiles
Assert-EntriesMatchRoot `
  -Root $packageRoot `
  -Entries $manifestFiles `
  -Label 'Payload'
Assert-EntriesMatchRoot `
  -Root $AppRoot `
  -Entries $targetPreconditions `
  -Label 'Target precondition'
Assert-EntriesMatchRoot `
  -Root $AppRoot `
  -Entries $preservedFiles `
  -Label 'Preserved file'
if ($isCoherentClientOverlay) {
  Assert-ExactClientSnapshot `
    -ClientSnapshotFiles $clientSnapshotFiles `
    -ManifestFiles $manifestFiles `
    -ReplaceFiles $replaceFiles `
    -PackageRoot $packageRoot
  Assert-ClientAssetGraph `
    -ClientRoot (Join-Path $packageRoot 'dist/client') `
    -VerifierPath $verifierPath `
    -NodePath $nodePath `
    -Label 'Packaged'
}

$oldPids = @(Get-AppNodePids -Root $AppRoot)
if ($oldPids.Count -eq 0) {
  throw 'No running application Node PID was found for this AppRoot.'
}

$backupBase = Join-Path $AppRoot 'output/hotfix-backups'
Assert-PathInside -Parent $AppRoot -Path $backupBase
Assert-PathChainHasNoReparsePoint -Root $AppRoot -Path $backupBase
$backupDirectory = Join-Path $backupBase (
  'purchase-receipt-' +
    (Get-Date -Format 'yyyyMMdd-HHmmss') +
    '-' +
    [Guid]::NewGuid().ToString('N').Substring(0, 12)
)
Assert-PathInside -Parent $backupBase -Path $backupDirectory

$deploymentStateEntered = $false
$serviceStoppedCleanly = $false
$runtimeMutationStarted = $false
$backupComplete = $false
$installationSucceeded = $false
$rollbackSucceeded = $false
$targetClientRoot = ''
$previousClientSnapshot = @()
$stagingBase = ''
$stagingDirectory = ''
$stagedClientRoot = ''
$retiredClientRoot = ''
$failedClientRoot = ''
$overlayReplaceFiles = if ($isCoherentClientOverlay) {
  @($replacementPreconditionPaths)
} else {
  @($replaceFiles)
}
try {
  if ($isCoherentClientOverlay) {
    $targetClientRoot = Convert-ToFullChildPath `
      -Root $AppRoot `
      -RelativePath 'dist/client'
    $previousClientSnapshot = @(
      Get-ClientSnapshotEntries `
        -TargetRoot $AppRoot `
        -ClientRoot $targetClientRoot
    )
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $previousClientSnapshot `
      -Label 'Current client before staging'

    $stagingBase = Join-Path $AppRoot 'output/hotfix-staging'
    Assert-PathInside -Parent $AppRoot -Path $stagingBase
    Assert-PathChainHasNoReparsePoint -Root $AppRoot -Path $stagingBase
    New-Item -ItemType Directory -Path $stagingBase -Force | Out-Null
    Assert-PathChainHasNoReparsePoint -Root $AppRoot -Path $stagingBase
    $stagingDirectory = Join-Path $stagingBase (
      'purchase-receipt-' + [Guid]::NewGuid().ToString('N')
    )
    Assert-PathInside -Parent $stagingBase -Path $stagingDirectory
    New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
    Assert-PathChainHasNoReparsePoint `
      -Root $stagingBase `
      -Path $stagingDirectory
    $stagedClientRoot = Join-Path $stagingDirectory 'payload-client'
    $retiredClientRoot = Join-Path $stagingDirectory 'retired-client'
    $failedClientRoot = Join-Path $stagingDirectory 'failed-client'
    foreach ($stagingChild in @(
        $stagedClientRoot,
        $retiredClientRoot,
        $failedClientRoot
      )) {
      Assert-PathInside -Parent $stagingDirectory -Path $stagingChild
    }
    Assert-SameVolume `
      -FirstPath $targetClientRoot `
      -SecondPath $stagedClientRoot `
      -Label 'Coherent client staging'
    Copy-ClientSnapshotToDirectory `
      -SourceRoot $packageRoot `
      -DestinationClientRoot $stagedClientRoot `
      -Entries $clientSnapshotFiles `
      -Label 'Staged client'
    Assert-ClientAssetGraph `
      -ClientRoot $stagedClientRoot `
      -VerifierPath $verifierPath `
      -NodePath $nodePath `
      -Label 'Staged'

    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Assert-PathChainHasNoReparsePoint `
      -Root $backupBase `
      -Path $backupDirectory
    Copy-EntriesToBackup `
      -SourceRoot $AppRoot `
      -BackupRoot $backupDirectory `
      -Entries $replacementPreconditions
    $backupClientRoot = Join-Path $backupDirectory 'dist/client'
    Assert-PathInside -Parent $backupDirectory -Path $backupClientRoot
    Copy-ClientSnapshotToDirectory `
      -SourceRoot $AppRoot `
      -DestinationClientRoot $backupClientRoot `
      -Entries $previousClientSnapshot `
      -Label 'Backup client'
    Assert-EntriesMatchRoot `
      -Root $backupDirectory `
      -Entries $replacementPreconditions `
      -Label 'Backup'
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $backupClientRoot `
      -Entries $previousClientSnapshot `
      -Label 'Backup client'
    Assert-EntriesMatchRoot `
      -Root $AppRoot `
      -Entries $replacementPreconditions `
      -Label 'Target precondition immediately before stop'
    Assert-EntriesMatchRoot `
      -Root $AppRoot `
      -Entries $preservedFiles `
      -Label 'Preserved file immediately before stop'
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $previousClientSnapshot `
      -Label 'Current client immediately before stop'
    $backupComplete = $true
  }

  $deploymentStateEntered = $true
  Invoke-AppScript -ScriptPath $stopScriptPath -Label 'Application stop'
  Wait-ProcessesStopped -ProcessIds $oldPids
  $serviceStoppedCleanly = $true
  $deploymentStartedAt = Get-Date

  if ($isCoherentClientOverlay) {
    Assert-EntriesMatchRoot `
      -Root $AppRoot `
      -Entries $replacementPreconditions `
      -Label 'Stopped target precondition'
    Assert-EntriesMatchRoot `
      -Root $AppRoot `
      -Entries $preservedFiles `
      -Label 'Stopped preserved file'
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $previousClientSnapshot `
      -Label 'Stopped client before exchange'
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $stagedClientRoot `
      -Entries $clientSnapshotFiles `
      -Label 'Staged client before exchange'
    Assert-SameVolume `
      -FirstPath $targetClientRoot `
      -SecondPath $retiredClientRoot `
      -Label 'Coherent client exchange'
    $runtimeMutationStarted = $true
    Move-Item `
      -LiteralPath $targetClientRoot `
      -Destination $retiredClientRoot
    Move-Item `
      -LiteralPath $stagedClientRoot `
      -Destination $targetClientRoot
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $clientSnapshotFiles `
      -Label 'Installed coherent client'
  } else {
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Assert-PathChainHasNoReparsePoint `
      -Root $backupBase `
      -Path $backupDirectory
    Copy-EntriesToBackup `
      -SourceRoot $AppRoot `
      -BackupRoot $backupDirectory `
      -Entries $replacementPreconditions
    Assert-EntriesMatchRoot `
      -Root $backupDirectory `
      -Entries $replacementPreconditions `
      -Label 'Backup'
    $backupComplete = $true
  }

  Copy-PayloadToTarget `
    -PackageRoot $packageRoot `
    -TargetRoot $AppRoot `
    -ReplaceFiles $overlayReplaceFiles
  $replacementEntries = @(
    $manifestFiles | Where-Object {
      $replaceSet.Contains((Assert-SafeRelativePath -Path ([string]$_.path)))
    }
  )
  Assert-EntriesMatchRoot `
    -Root $AppRoot `
    -Entries $replacementEntries `
    -Label 'Installed payload'
  Assert-EntriesMatchRoot `
    -Root $AppRoot `
    -Entries $preservedFiles `
    -Label 'Preserved file after copy'
  if ($isCoherentClientOverlay) {
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $clientSnapshotFiles `
      -Label 'Installed coherent client after copy'
  }

  Invoke-AppScript -ScriptPath $startScriptPath -Label 'Application start'
  $newProcess = Get-VerifiedStartedProcess `
    -Root $AppRoot `
    -ForbiddenPids $oldPids `
    -NotBefore $deploymentStartedAt
  if ($newProcess.Id -in $oldPids -or $newProcess.StartTime -lt $deploymentStartedAt) {
    throw 'Application process identity did not change after deployment.'
  }
  Assert-Health200 -Url $HealthUrl -CurlPath $curlPath

  Assert-EntriesMatchRoot `
    -Root $AppRoot `
    -Entries $replacementEntries `
    -Label 'Installed payload after restart'
  Assert-EntriesMatchRoot `
    -Root $AppRoot `
    -Entries $preservedFiles `
    -Label 'Preserved file after restart'
  if ($isCoherentClientOverlay) {
    Assert-ClientSnapshotAtDirectory `
      -ClientRoot $targetClientRoot `
      -Entries $clientSnapshotFiles `
      -Label 'Installed coherent client after restart'
    Assert-ClientAssetGraph `
      -ClientRoot $targetClientRoot `
      -VerifierPath $verifierPath `
      -NodePath $nodePath `
      -Label 'Installed'
    Assert-ServedClientMainHash `
      -HealthUri $healthUri `
      -ExpectedSha256 $clientMainHash `
      -CurlPath $curlPath
  }

  $installationSucceeded = $true
  Write-Host '[OK] Hotfix installed and validated.' -ForegroundColor Green
  Write-Host "[OK] Backup: $backupDirectory"
  Write-Host "[OK] New application PID: $($newProcess.Id)"
} catch {
  $installationError = $_.Exception.Message
  $rollbackError = ''
  if ($deploymentStateEntered) {
    try {
      if (
        $isCoherentClientOverlay -and
        $serviceStoppedCleanly -and
        !$runtimeMutationStarted
      ) {
        Write-Host '[ROLLBACK] No runtime files were changed; restarting the current runtime.' -ForegroundColor Yellow
        Invoke-AppScript `
          -ScriptPath $startScriptPath `
          -Label 'Aborted deployment restart'
        Write-Host '[OK] Rollback completed; the unchanged runtime was restarted.' -ForegroundColor Green
      } elseif ($isCoherentClientOverlay) {
        Invoke-CoherentClientRollback `
          -StopScript $stopScriptPath `
          -StartScript $startScriptPath `
          -BackupRoot $backupDirectory `
          -TargetRoot $AppRoot `
          -ServerPreconditions $replacementPreconditions `
          -BackupComplete $backupComplete `
          -TargetClientRoot $targetClientRoot `
          -RetiredClientRoot $retiredClientRoot `
          -FailedClientRoot $failedClientRoot `
          -StagingRoot $stagingDirectory `
          -PreviousClientSnapshot $previousClientSnapshot
      } else {
        Invoke-Rollback `
          -StopScript $stopScriptPath `
          -StartScript $startScriptPath `
          -BackupRoot $backupDirectory `
          -TargetRoot $AppRoot `
          -Preconditions $replacementPreconditions `
          -BackupComplete $backupComplete
      }
      $rollbackSucceeded = $true
    } catch {
      $rollbackError = $_.Exception.Message
    }
  }
  if ($rollbackError) {
    throw "Hotfix installation failed: $installationError Rollback failed: $rollbackError"
  }
  throw "Hotfix installation failed: $installationError"
} finally {
  if ($isCoherentClientOverlay) {
    $canCleanStaging = (
      $installationSucceeded -or
      $rollbackSucceeded -or
      !$deploymentStateEntered
    )
    if (
      $canCleanStaging -and
      $stagingBase -and
      $stagingDirectory -and
      (Test-Path -LiteralPath $stagingDirectory)
    ) {
      try {
        Remove-SafeDirectory `
          -ApprovedRoot $stagingBase `
          -Path $stagingDirectory
      } catch {
        Write-Warning "Could not remove coherent client staging directory: $($_.Exception.Message)"
      }
    }
    if (
      !$deploymentStateEntered -and
      (Test-Path -LiteralPath $backupDirectory)
    ) {
      try {
        Remove-SafeDirectory `
          -ApprovedRoot $backupBase `
          -Path $backupDirectory
      } catch {
        Write-Warning "Could not remove unused hotfix backup: $($_.Exception.Message)"
      }
    }
  }
}
