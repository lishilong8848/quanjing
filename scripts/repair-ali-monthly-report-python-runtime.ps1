[CmdletBinding()]
param(
  [string]$AppRoot = '',
  [string]$Python = '',
  [string]$PackagePath = '',
  [string]$PortablePythonArchivePath = '',
  [string]$Pywin32RepairArchivePath = '',
  [switch]$ForcePortablePython,
  [switch]$NoRestart,
  [ValidateRange(1, 3600)][int]$ServiceStopTimeoutSeconds = 120,
  [ValidateRange(1, 3600)][int]$ServiceStartTimeoutSeconds = 420,
  [ValidateRange(1, 3600)][int]$RollbackStartTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:StagingPath = $null
$script:EnvTempPath = $null
$script:EnvBackupPath = $null
$script:EnvExisted = $false
$script:EnvChanged = $false
$script:BundleBackupPath = $null
$script:BundleChanged = $false
$script:ResolvedAppRoot = $null
$script:ExpectedBundlePath = $null
$script:ServiceStopped = $false
$script:LastPythonRuntimeError = ''

function Write-RepairProgress {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][string]$Message
  )

  Write-Output ("[STEP $Step] $((Get-Date).ToString('HH:mm:ss')) $Message")
}

function Write-RepairSubstep {
  param(
    [Parameter(Mandatory = $true)][string]$Substep,
    [Parameter(Mandatory = $true)][string]$Message
  )

  Write-Output ("[STEP 5/6][$Substep] $((Get-Date).ToString('HH:mm:ss')) $Message")
}

function Test-IsTransientFileSystemException {
  param([Parameter(Mandatory = $true)][System.Exception]$Exception)

  $current = $Exception
  while ($null -ne $current) {
    if ($current -is [System.UnauthorizedAccessException] -or $current -is [System.IO.IOException]) {
      return $true
    }
    $current = $current.InnerException
  }
  return $false
}

function Invoke-WithFileSystemRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [int]$MaxAttempts = 4
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      & $Action
      return
    } catch {
      if (-not (Test-IsTransientFileSystemException -Exception $_.Exception) -or $attempt -ge $MaxAttempts) {
        throw
      }
      $delaySeconds = $attempt
      Write-RepairProgress -Step '3/6' -Message "$Operation was temporarily blocked. Retrying in $delaySeconds second(s), attempt $($attempt + 1)/$MaxAttempts..."
      Start-Sleep -Seconds $delaySeconds
    }
  }
}

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path)
}

function Invoke-NativeCommandCaptured {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @()
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Executable @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    Output = $output
    ExitCode = $exitCode
  }
}

function Stop-VerifiedProcessTree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  if ($Process.HasExited) {
    return
  }

  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $taskkill /PID $Process.Id /T /F 1>$null 2>$null
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  }
  if (-not $Process.WaitForExit(15000)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    if (-not $Process.WaitForExit(5000)) {
      throw "Timed-out child process tree could not be stopped. PID=$($Process.Id)"
    }
  }
}

function Invoke-PowerShellScriptWithTimeout {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [switch]$NoBrowser
  )

  $escapedScriptPath = $ScriptPath.Replace("'", "''")
  $scriptArguments = if ($NoBrowser) { ' -NoBrowser' } else { '' }
  $childCommand = "`$ErrorActionPreference = 'Stop'; try { `$global:LASTEXITCODE = 0; & '$escapedScriptPath'$scriptArguments; exit `$global:LASTEXITCODE } catch { Write-Error `$_; exit 1 }"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
  $powerShell = Join-Path $PSHOME 'powershell.exe'
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powerShell
  $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false

  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw "$Description process did not start."
  }
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-VerifiedProcessTree -Process $process
      throw "$Description timed out after $TimeoutSeconds second(s). The child process tree was stopped."
    }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
    }
  } finally {
    $process.Dispose()
  }
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )

  $parentFull = (Get-FullPath -Path $Parent).TrimEnd('\') + '\'
  $childFull = Get-FullPath -Path $Child
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe path outside the application root: $childFull"
  }
}

function Convert-ToExtendedWindowsPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = Get-FullPath -Path $Path
  if ($fullPath.StartsWith('\\')) {
    return '\\?\UNC\' + $fullPath.Substring(2)
  }
  return '\\?\' + $fullPath
}

function Resolve-ApplicationRoot {
  param([string]$RequestedRoot)

  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    $candidates.Add($RequestedRoot)
  } else {
    $candidates.Add($PSScriptRoot)
    $candidates.Add((Split-Path -Parent $PSScriptRoot))
    $candidates.Add((Get-Location).Path)
  }

  foreach ($candidate in $candidates) {
    $resolved = Get-FullPath -Path $candidate
    if (Test-Path -LiteralPath (Join-Path $resolved 'dist\server\main.js') -PathType Leaf) {
      return $resolved
    }
  }

  throw 'Application root was not found. Expected dist\server\main.js.'
}

function Test-BundleCandidateLayout {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (
    (Test-Path -LiteralPath (Join-Path $Path 'pythoncom.py') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path 'win32com\client\__init__.py') -PathType Leaf)
  )
}

function Get-RequiredPywin32Files {
  return @(
    'pythoncom.py',
    'pywin32.pth',
    'pywin32_system32\pythoncom312.dll',
    'pywin32_system32\pywintypes312.dll',
    'win32\_win32sysloader.pyd',
    'win32\win32api.pyd',
    'win32\lib\pywin32_bootstrap.py',
    'win32\lib\pywintypes.py',
    'win32com\__init__.py',
    'win32com\client\__init__.py'
  )
}

function Get-MissingPywin32Files {
  param([Parameter(Mandatory = $true)][string]$Path)

  $missing = New-Object System.Collections.Generic.List[string]
  foreach ($relativePath in (Get-RequiredPywin32Files)) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path $relativePath) -PathType Leaf)) {
      $missing.Add($relativePath)
    }
  }
  return $missing.ToArray()
}

function Test-BundleLayout {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Test-BundleCandidateLayout -Path $Path) -and ((@(Get-MissingPywin32Files -Path $Path)).Count -eq 0)
}

function Get-BundlePythonPathEntries {
  param([Parameter(Mandatory = $true)][string]$BundlePath)

  $entries = New-Object System.Collections.Generic.List[string]
  $entries.Add((Get-FullPath -Path $BundlePath))
  foreach ($relativePath in @('win32', 'win32\lib', 'Pythonwin')) {
    $entries.Add((Get-FullPath -Path (Join-Path $BundlePath $relativePath)))
  }
  return $entries.ToArray()
}

function Find-DirectoryBundle {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedPath
  )

  if (Test-BundleCandidateLayout -Path $ExpectedPath) {
    return $ExpectedPath
  }

  $containers = New-Object System.Collections.Generic.List[string]
  $containers.Add($Root)
  $hotfixOutput = Join-Path $Root 'output\hotfix'
  if (Test-Path -LiteralPath $hotfixOutput -PathType Container) {
    $containers.Add($hotfixOutput)
  }
  if ((Get-FullPath -Path $PSScriptRoot) -ne (Get-FullPath -Path $Root)) {
    $containers.Add($PSScriptRoot)
  }
  $currentDirectory = (Get-Location).Path
  if (
    (Get-FullPath -Path $currentDirectory) -ne (Get-FullPath -Path $Root) -and
    (Get-FullPath -Path $currentDirectory) -ne (Get-FullPath -Path $PSScriptRoot)
  ) {
    $containers.Add($currentDirectory)
  }

  foreach ($container in $containers) {
    if (-not (Test-Path -LiteralPath $container -PathType Container)) {
      continue
    }

    $direct = Join-Path $container 'python\ali-monthly-report-packages'
    if ((Get-FullPath -Path $direct) -ne (Get-FullPath -Path $ExpectedPath) -and (Test-BundleCandidateLayout -Path $direct)) {
      return $direct
    }

    $packageDirectories = Get-ChildItem -LiteralPath $container -Directory -Filter 'ali-monthly-report-server-runtime-hotfix-*' -ErrorAction SilentlyContinue
    foreach ($packageDirectory in $packageDirectories) {
      $nested = Join-Path $packageDirectory.FullName 'python\ali-monthly-report-packages'
      if (Test-BundleCandidateLayout -Path $nested) {
        return $nested
      }
    }
  }

  return $null
}

function Find-PackageArchive {
  param(
    [string]$RequestedPackage,
    [Parameter(Mandatory = $true)][string]$Root
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedPackage)) {
    $resolved = Get-FullPath -Path $RequestedPackage
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Package archive does not exist: $resolved"
    }
    return $resolved
  }

  $searchRoots = @($PSScriptRoot, $Root, (Join-Path $Root 'output\hotfix'), (Get-Location).Path)
  $archives = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  foreach ($searchRoot in ($searchRoots | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $searchRoot -PathType Container) {
      Get-ChildItem -LiteralPath $searchRoot -File -Filter 'ali-monthly-report-server-runtime-hotfix-*.zip' -ErrorAction SilentlyContinue |
        ForEach-Object { $archives.Add($_) }
    }
  }

  $latest = $archives | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($null -eq $latest) {
    return $null
  }
  return $latest.FullName
}

function Expand-BundleFromArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $prefix = 'python/ali-monthly-report-packages/'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $normalized = $entry.FullName.Replace('\', '/')
      if (-not $normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }

      $relative = $normalized.Substring($prefix.Length)
      if ([string]::IsNullOrWhiteSpace($relative)) {
        continue
      }

      $target = Join-Path $Destination $relative.Replace('/', '\')
      Assert-ChildPath -Parent $Destination -Child $target
      if ($normalized.EndsWith('/')) {
        [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $target))
        continue
      }

      $targetParent = Split-Path -Parent $target
      [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $targetParent))
      $inputStream = $entry.Open()
      try {
        $outputStream = [System.IO.File]::Open((Convert-ToExtendedWindowsPath -Path $target), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $inputStream.CopyTo($outputStream)
        } finally {
          $outputStream.Dispose()
        }
      } finally {
        $inputStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Copy-BundleToStaging {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if (Test-Path -LiteralPath $robocopy -PathType Leaf) {
    & $robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) {
      throw "Failed to stage the bundled Python dependencies. Robocopy exit code: $LASTEXITCODE"
    }
  } else {
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
  }
}

function Get-DotEnvValue {
  param(
    [string[]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $pattern = '^\s*(?:export\s+)?' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
  foreach ($line in $Lines) {
    $match = [regex]::Match($line, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
      continue
    }
    $value = $match.Groups[1].Value.Trim()
    if ($value.Length -ge 2) {
      if (($value.StartsWith("'") -and $value.EndsWith("'")) -or ($value.StartsWith('"') -and $value.EndsWith('"'))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    return $value
  }
  return ''
}

function Get-DotEnvLines {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return @()
  }
  return [System.IO.File]::ReadAllLines($Path)
}

function Resolve-ExecutablePath {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $null
  }
  $trimmed = $Candidate.Trim().Trim("'").Trim('"')
  if (Test-Path -LiteralPath $trimmed -PathType Leaf) {
    return Get-FullPath -Path $trimmed
  }
  $command = Get-Command $trimmed -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) {
    return $null
  }
  return $command.Source
}

function Get-RegistryPythonCandidates {
  $registryPaths = @(
    'HKCU:\Software\Python\PythonCore\3.12\InstallPath',
    'HKLM:\Software\Python\PythonCore\3.12\InstallPath',
    'HKLM:\Software\WOW6432Node\Python\PythonCore\3.12\InstallPath'
  )
  $results = New-Object System.Collections.Generic.List[string]
  foreach ($registryPath in $registryPaths) {
    try {
      $key = Get-Item -LiteralPath $registryPath -ErrorAction Stop
      $executablePath = [string]$key.GetValue('ExecutablePath', '')
      if (-not [string]::IsNullOrWhiteSpace($executablePath)) {
        $results.Add($executablePath)
      }
      $installPath = [string]$key.GetValue('', '')
      if (-not [string]::IsNullOrWhiteSpace($installPath)) {
        $results.Add((Join-Path $installPath 'python.exe'))
      }
    } catch {
      continue
    }
  }
  return $results.ToArray()
}

function Get-Sha256ForBytes {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
}

function Read-EmbeddedBase64Payload {
  param(
    [Parameter(Mandatory = $true)][string]$SelfPath,
    [Parameter(Mandatory = $true)][string]$StartMarker,
    [string]$EndMarker = '',
    [Parameter(Mandatory = $true)][string]$PayloadName
  )

  $reader = [System.IO.File]::OpenText($SelfPath)
  $builder = New-Object System.Text.StringBuilder
  $foundStart = $false
  $foundEnd = [string]::IsNullOrWhiteSpace($EndMarker)
  try {
    while (($line = $reader.ReadLine()) -ne $null) {
      if (-not $foundStart) {
        if ($line -eq $StartMarker) {
          $foundStart = $true
        }
        continue
      }
      if (-not [string]::IsNullOrWhiteSpace($EndMarker) -and $line -eq $EndMarker) {
        $foundEnd = $true
        break
      }
      [void]$builder.Append($line.Trim())
    }
  } finally {
    $reader.Dispose()
  }

  if (-not $foundStart -or -not $foundEnd -or $builder.Length -eq 0) {
    throw "Embedded $PayloadName payload is missing."
  }
  try {
    return ,([Convert]::FromBase64String($builder.ToString()))
  } catch {
    throw "Embedded $PayloadName payload is not valid Base64."
  }
}

function Resolve-PortablePythonArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$RequestedArchive
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedArchive)) {
    $resolved = Get-FullPath -Path $RequestedArchive
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Portable Python archive does not exist: $resolved"
    }
    return $resolved
  }

  $expectedSha256 = [string]$env:ALI_REPAIR_PYTHON_SHA256
  $selfPath = [string]$env:ALI_REPAIR_SELF
  if ([string]::IsNullOrWhiteSpace($expectedSha256) -or [string]::IsNullOrWhiteSpace($selfPath)) {
    return $null
  }
  if ($expectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'Embedded portable Python SHA-256 metadata is invalid.'
  }
  if (-not (Test-Path -LiteralPath $selfPath -PathType Leaf)) {
    throw 'The self-contained CMD file cannot be read.'
  }

  $downloadDirectory = Join-Path $Root '.runtime\downloads'
  New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
  Assert-ChildPath -Parent $Root -Child $downloadDirectory
  $archivePath = Join-Path $downloadDirectory 'python-3.12.7-ali-portable.zip'
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($existingHash -eq $expectedSha256) {
      return $archivePath
    }
  }

  $archiveBytes = Read-EmbeddedBase64Payload -SelfPath $selfPath -StartMarker '@@PORTABLE_PYTHON_ZIP_BASE64@@' -EndMarker '@@PYWIN32_REPAIR_ZIP_BASE64@@' -PayloadName 'portable Python'
  $actualSha256 = Get-Sha256ForBytes -Bytes $archiveBytes
  if ($actualSha256 -ne $expectedSha256) {
    throw 'Embedded portable Python SHA-256 validation failed.'
  }

  $temporaryArchive = $archivePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  Assert-ChildPath -Parent $Root -Child $temporaryArchive
  try {
    [System.IO.File]::WriteAllBytes($temporaryArchive, $archiveBytes)
    if (Test-Path -LiteralPath $archivePath) {
      Remove-Item -LiteralPath $archivePath -Force
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
  } finally {
    if (Test-Path -LiteralPath $temporaryArchive) {
      Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
    }
  }
  return $archivePath
}

function Resolve-Pywin32RepairArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$RequestedArchive
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedArchive)) {
    $resolved = Get-FullPath -Path $RequestedArchive
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Pywin32 repair archive does not exist: $resolved"
    }
    return $resolved
  }

  $expectedSha256 = [string]$env:ALI_REPAIR_PYWIN32_SHA256
  $selfPath = [string]$env:ALI_REPAIR_SELF
  if ([string]::IsNullOrWhiteSpace($expectedSha256) -or [string]::IsNullOrWhiteSpace($selfPath)) {
    return $null
  }
  if ($expectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'Embedded pywin32 repair SHA-256 metadata is invalid.'
  }
  if (-not (Test-Path -LiteralPath $selfPath -PathType Leaf)) {
    throw 'The self-contained CMD file cannot be read.'
  }

  $downloadDirectory = Join-Path $Root '.runtime\downloads'
  New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
  Assert-ChildPath -Parent $Root -Child $downloadDirectory
  $archivePath = Join-Path $downloadDirectory 'pywin32-3.12-x64-ali-repair.zip'
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($existingHash -eq $expectedSha256) {
      return $archivePath
    }
  }

  $archiveBytes = Read-EmbeddedBase64Payload -SelfPath $selfPath -StartMarker '@@PYWIN32_REPAIR_ZIP_BASE64@@' -PayloadName 'pywin32 repair'
  $actualSha256 = Get-Sha256ForBytes -Bytes $archiveBytes
  if ($actualSha256 -ne $expectedSha256) {
    throw 'Embedded pywin32 repair SHA-256 validation failed.'
  }

  $temporaryArchive = $archivePath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  Assert-ChildPath -Parent $Root -Child $temporaryArchive
  try {
    [System.IO.File]::WriteAllBytes($temporaryArchive, $archiveBytes)
    if (Test-Path -LiteralPath $archivePath) {
      Remove-Item -LiteralPath $archivePath -Force
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
  } finally {
    if (Test-Path -LiteralPath $temporaryArchive) {
      Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
    }
  }
  return $archivePath
}

function Expand-Pywin32RepairArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $normalized = $entry.FullName.Replace('\', '/')
      while ($normalized.StartsWith('./')) {
        $normalized = $normalized.Substring(2)
      }
      if ([string]::IsNullOrWhiteSpace($normalized)) {
        continue
      }
      $target = Join-Path $Destination $normalized.Replace('/', '\')
      Assert-ChildPath -Parent $Destination -Child $target
      if ($normalized.EndsWith('/')) {
        [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $target))
        continue
      }
      $targetParent = Split-Path -Parent $target
      [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $targetParent))
      $inputStream = $entry.Open()
      try {
        $outputStream = [System.IO.File]::Open((Convert-ToExtendedWindowsPath -Path $target), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $inputStream.CopyTo($outputStream)
        } finally {
          $outputStream.Dispose()
        }
      } finally {
        $inputStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Expand-PortablePythonArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $normalized = $entry.FullName.Replace('\', '/')
      if ([string]::IsNullOrWhiteSpace($normalized)) {
        continue
      }
      $target = Join-Path $Destination $normalized.Replace('/', '\')
      Assert-ChildPath -Parent $Destination -Child $target
      if ($normalized.EndsWith('/')) {
        [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $target))
        continue
      }
      $targetParent = Split-Path -Parent $target
      [void][System.IO.Directory]::CreateDirectory((Convert-ToExtendedWindowsPath -Path $targetParent))
      $inputStream = $entry.Open()
      try {
        $outputStream = [System.IO.File]::Open((Convert-ToExtendedWindowsPath -Path $target), [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
          $inputStream.CopyTo($outputStream)
        } finally {
          $outputStream.Dispose()
        }
      } finally {
        $inputStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Test-PythonRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [Parameter(Mandatory = $true)][string]$ProbePath
  )

  $identityCode = "import json,platform,struct,sys; print(json.dumps({'major':sys.version_info.major,'minor':sys.version_info.minor,'bits':struct.calcsize('P')*8,'system':platform.system()}))"
  $script:LastPythonRuntimeError = ''
  $identityResult = Invoke-NativeCommandCaptured -Executable $Candidate -Arguments @('-c', $identityCode)
  if ($identityResult.ExitCode -ne 0) {
    $script:LastPythonRuntimeError = 'Python identity check failed.'
    return $false
  }

  try {
    $identityLine = $identityResult.Output | Where-Object { $_.ToString().Trim().StartsWith('{') } | Select-Object -Last 1
    $identity = $identityLine | ConvertFrom-Json
  } catch {
    $script:LastPythonRuntimeError = 'Python identity output was invalid.'
    return $false
  }

  if (
    [int]$identity.major -ne 3 -or
    [int]$identity.minor -ne 12 -or
    [int]$identity.bits -ne 64 -or
    [string]$identity.system -ne 'Windows'
  ) {
    $script:LastPythonRuntimeError = 'Python must be 64-bit Windows Python 3.12.'
    return $false
  }

  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = (Get-BundlePythonPathEntries -BundlePath $BundlePath) -join ';'
    if (-not [string]::IsNullOrWhiteSpace($previousPythonPath)) {
      $env:PYTHONPATH = $env:PYTHONPATH + ';' + $previousPythonPath
    }
    $probeResult = Invoke-NativeCommandCaptured -Executable $Candidate -Arguments @($ProbePath, 'legacy')
    if ($probeResult.ExitCode -eq 0) {
      return $true
    }
    $probeSummary = $probeResult.Output |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { $_ -match '^missing_or_broken=[A-Za-z0-9_.,() -]+$' } |
      Select-Object -Last 1
    $script:LastPythonRuntimeError = if ($null -ne $probeSummary) {
      $probeSummary
    } else {
      'Python dependency probe failed.'
    }
    return $false
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
}

function Install-PortablePythonRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [Parameter(Mandatory = $true)][string]$ProbePath,
    [string]$RequestedArchive
  )

  $runtimeParent = Join-Path $Root '.runtime'
  $runtimePath = Join-Path $runtimeParent 'python312-ali-monthly-report'
  $pythonPath = Join-Path $runtimePath 'python.exe'
  New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
  Assert-ChildPath -Parent $Root -Child $runtimePath

  if (
    (Test-Path -LiteralPath $pythonPath -PathType Leaf) -and
    (Test-PythonRuntime -Candidate $pythonPath -BundlePath $BundlePath -ProbePath $ProbePath)
  ) {
    return $pythonPath
  }

  $archivePath = Resolve-PortablePythonArchive -Root $Root -RequestedArchive $RequestedArchive
  if ($null -eq $archivePath) {
    throw 'No usable Python 3.12 was found and this repair file does not contain a portable Python runtime.'
  }

  $stagingPath = Join-Path $runtimeParent ('.python312-ali-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $backupPath = $null
  Assert-ChildPath -Parent $Root -Child $stagingPath
  try {
    Invoke-WithFileSystemRetry -Operation 'Creating the portable Python staging directory' -Action {
      New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
    }
    Invoke-WithFileSystemRetry -Operation 'Extracting the portable Python runtime' -Action {
      Expand-PortablePythonArchive -ArchivePath $archivePath -Destination $stagingPath
    }
    $stagedPython = Join-Path $stagingPath 'python.exe'
    if (
      -not (Test-Path -LiteralPath $stagedPython -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $stagingPath 'python312.dll') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $stagingPath 'Lib\encodings\__init__.py') -PathType Leaf)
    ) {
      throw 'Portable Python archive is incomplete.'
    }

    if (Test-Path -LiteralPath $runtimePath) {
      $backupPath = $runtimePath + '.backup.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
      Assert-ChildPath -Parent $Root -Child $backupPath
      Invoke-WithFileSystemRetry -Operation 'Backing up the previous portable Python runtime' -Action {
        Move-Item -LiteralPath $runtimePath -Destination $backupPath
      }
    }
    Invoke-WithFileSystemRetry -Operation 'Promoting the portable Python runtime' -Action {
      Move-Item -LiteralPath $stagingPath -Destination $runtimePath
    }
    if (-not (Test-PythonRuntime -Candidate $pythonPath -BundlePath $BundlePath -ProbePath $ProbePath)) {
      throw ('Portable Python validation failed. ' + $script:LastPythonRuntimeError)
    }

    if ($null -ne $backupPath -and (Test-Path -LiteralPath $backupPath)) {
      Assert-ChildPath -Parent $Root -Child $backupPath
      Remove-Item -LiteralPath $backupPath -Recurse -Force
      $backupPath = $null
    }
    return $pythonPath
  } catch {
    if (Test-Path -LiteralPath $runtimePath) {
      Assert-ChildPath -Parent $Root -Child $runtimePath
      Remove-Item -LiteralPath $runtimePath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $backupPath -and (Test-Path -LiteralPath $backupPath)) {
      Move-Item -LiteralPath $backupPath -Destination $runtimePath
      $backupPath = $null
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $stagingPath) {
      Assert-ChildPath -Parent $Root -Child $stagingPath
      Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Select-PythonRuntime {
  param(
    [string]$RequestedPython,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [Parameter(Mandatory = $true)][string]$ProbePath,
    [string[]]$EnvLocalLines,
    [string[]]$EnvLines,
    [string]$PortableArchive,
    [switch]$ForcePortable
  )

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($ForcePortable) {
    $portablePython = Install-PortablePythonRuntime -Root $Root -BundlePath $BundlePath -ProbePath $ProbePath -RequestedArchive $PortableArchive
    return $portablePython
  } elseif (-not [string]::IsNullOrWhiteSpace($RequestedPython)) {
    $candidates.Add($RequestedPython)
  } else {
    $candidates.Add($env:ALI_MONTHLY_REPORT_PYTHON)
    $candidates.Add((Get-DotEnvValue -Lines $EnvLocalLines -Name 'ALI_MONTHLY_REPORT_PYTHON'))
    $candidates.Add((Get-DotEnvValue -Lines $EnvLines -Name 'ALI_MONTHLY_REPORT_PYTHON'))
    $candidates.Add((Join-Path $Root '.venv-ali-report\Scripts\python.exe'))
    $candidates.Add('C:\Program Files\Python312\python.exe')
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'))
    }
    foreach ($registryCandidate in (Get-RegistryPythonCandidates)) {
      $candidates.Add($registryCandidate)
    }
    $pyLauncher = Get-Command 'py.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pyLauncher) {
      $launcherOutput = @(& $pyLauncher.Source -3.12 -c 'import sys; print(sys.executable)' 2>&1)
      if ($LASTEXITCODE -eq 0 -and $launcherOutput.Count -gt 0) {
        $candidates.Add([string]$launcherOutput[-1])
      }
    }
    $candidates.Add('python.exe')
    $candidates.Add('python')
  }

  foreach ($candidate in ($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
    $resolved = Resolve-ExecutablePath -Candidate $candidate
    if ($null -ne $resolved -and (Test-PythonRuntime -Candidate $resolved -BundlePath $BundlePath -ProbePath $ProbePath)) {
      return $resolved
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedPython)) {
    throw ('The requested Python executable is not usable. ' + $script:LastPythonRuntimeError)
  }
  $portablePython = Install-PortablePythonRuntime -Root $Root -BundlePath $BundlePath -ProbePath $ProbePath -RequestedArchive $PortableArchive
  return $portablePython
}

function Merge-PythonPath {
  param(
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [string]$ExistingValue
  )

  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($bundleEntry in (Get-BundlePythonPathEntries -BundlePath $BundlePath)) {
    $parts.Add($bundleEntry)
  }
  if (-not [string]::IsNullOrWhiteSpace($ExistingValue)) {
    foreach ($part in $ExistingValue.Split(';')) {
      $trimmed = $part.Trim()
      if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
        $parts.Add($trimmed)
      }
    }
  }
  return (($parts | Select-Object -Unique) -join ';')
}

function Set-DotEnvValues {
  param(
    [string[]]$Lines,
    [Parameter(Mandatory = $true)][hashtable]$Values
  )

  $result = New-Object System.Collections.Generic.List[string]
  $written = @{}
  foreach ($line in $Lines) {
    $matchedName = $null
    foreach ($name in $Values.Keys) {
      $pattern = '^\s*(?:export\s+)?' + [regex]::Escape([string]$name) + '\s*='
      if ($line -match $pattern) {
        $matchedName = [string]$name
        break
      }
    }

    if ($null -eq $matchedName) {
      $result.Add($line)
      continue
    }
    if ($written.ContainsKey($matchedName)) {
      continue
    }

    $value = [string]$Values[$matchedName]
    if ($value.Contains("'")) {
      throw "Cannot write $matchedName because its value contains a single quote."
    }
    $result.Add($matchedName + "='" + $value + "'")
    $written[$matchedName] = $true
  }

  foreach ($name in $Values.Keys) {
    if (-not $written.ContainsKey([string]$name)) {
      $value = [string]$Values[$name]
      if ($value.Contains("'")) {
        throw "Cannot write $name because its value contains a single quote."
      }
      $result.Add(([string]$name) + "='" + $value + "'")
    }
  }

  return $result.ToArray()
}

function Write-DotEnvAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string[]]$Lines
  )

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $script:EnvTempPath = $Path + '.ali-monthly-report-repair.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $script:EnvExisted = Test-Path -LiteralPath $Path -PathType Leaf
  $script:EnvBackupPath = $Path + '.ali-monthly-report-repair-' + $timestamp + '.bak'
  $encoding = New-Object System.Text.UTF8Encoding($false)
  $content = ($Lines -join [Environment]::NewLine) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($script:EnvTempPath, $content, $encoding)

  if ($script:EnvExisted) {
    [System.IO.File]::Replace($script:EnvTempPath, $Path, $script:EnvBackupPath, $true)
  } else {
    [System.IO.File]::Move($script:EnvTempPath, $Path)
    $script:EnvBackupPath = $null
  }
  $script:EnvTempPath = $null
  $script:EnvChanged = $true
}

function Restore-Changes {
  if ($script:EnvChanged) {
    if ($script:EnvExisted -and $null -ne $script:EnvBackupPath -and (Test-Path -LiteralPath $script:EnvBackupPath -PathType Leaf)) {
      Copy-Item -LiteralPath $script:EnvBackupPath -Destination (Join-Path $script:ResolvedAppRoot '.env.local') -Force
    } elseif (-not $script:EnvExisted) {
      Remove-Item -LiteralPath (Join-Path $script:ResolvedAppRoot '.env.local') -Force -ErrorAction SilentlyContinue
    }
  }

  if ($script:BundleChanged) {
    if (Test-Path -LiteralPath $script:ExpectedBundlePath) {
      Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:ExpectedBundlePath
      Remove-Item -LiteralPath $script:ExpectedBundlePath -Recurse -Force
    }
    if ($null -ne $script:BundleBackupPath -and (Test-Path -LiteralPath $script:BundleBackupPath -PathType Container)) {
      Move-Item -LiteralPath $script:BundleBackupPath -Destination $script:ExpectedBundlePath
    }
  }
}

function Find-ServiceScript {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('start', 'stop')][string]$Action
  )

  $relativeCandidates = if ($Action -eq 'stop') {
    @('deploy\stop.ps1', 'stop.ps1')
  } else {
    @('start.ps1', 'deploy\start.ps1')
  }
  foreach ($relative in $relativeCandidates) {
    $candidate = Join-Path $Root $relative
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "Application $Action script was not found."
}

function Invoke-ServiceStop {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $stopScript = Find-ServiceScript -Root $Root -Action 'stop'
  $result = Invoke-PowerShellScriptWithTimeout -ScriptPath $stopScript -WorkingDirectory $Root -Description 'Service stop' -TimeoutSeconds $TimeoutSeconds
  if ($result.ExitCode -ne 0) {
    throw "Service stop failed with exit code $($result.ExitCode)."
  }
}

function Invoke-ServiceStart {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $startScript = Find-ServiceScript -Root $Root -Action 'start'
  $startScriptText = [System.IO.File]::ReadAllText($startScript)
  $supportsNoBrowser = $startScriptText -match '(?i)\$NoBrowser\b'
  $result = Invoke-PowerShellScriptWithTimeout -ScriptPath $startScript -WorkingDirectory $Root -Description 'Service restart' -TimeoutSeconds $TimeoutSeconds -NoBrowser:$supportsNoBrowser
  if ($result.ExitCode -ne 0) {
    throw "Service restart failed with exit code $($result.ExitCode)."
  }
}

try {
  Write-RepairProgress -Step '1/6' -Message 'Locating the application and bundled dependencies...'
  $script:ResolvedAppRoot = Resolve-ApplicationRoot -RequestedRoot $AppRoot
  $script:ExpectedBundlePath = Join-Path $script:ResolvedAppRoot 'python\ali-monthly-report-packages'
  $pythonParent = Split-Path -Parent $script:ExpectedBundlePath
  New-Item -ItemType Directory -Path $pythonParent -Force | Out-Null
  Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:ExpectedBundlePath

  $sourceBundle = Find-DirectoryBundle -Root $script:ResolvedAppRoot -ExpectedPath $script:ExpectedBundlePath
  if ($null -eq $sourceBundle) {
    $archive = Find-PackageArchive -RequestedPackage $PackagePath -Root $script:ResolvedAppRoot
    if ($null -eq $archive) {
      throw 'Bundled Python dependencies were not found beside the application or in a runtime hotfix archive.'
    }
    $script:StagingPath = Join-Path $pythonParent ('.ali-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:StagingPath
    New-Item -ItemType Directory -Path $script:StagingPath -Force | Out-Null
    Expand-BundleFromArchive -ArchivePath $archive -Destination $script:StagingPath
    $sourceBundle = $script:StagingPath
  } elseif ((Get-FullPath -Path $sourceBundle) -ne (Get-FullPath -Path $script:ExpectedBundlePath)) {
    $script:StagingPath = Join-Path $pythonParent ('.ali-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:StagingPath
    Copy-BundleToStaging -Source $sourceBundle -Destination $script:StagingPath
    $sourceBundle = $script:StagingPath
  }

  Write-RepairProgress -Step '2/6' -Message 'Checking and repairing the pywin32 dependency bundle...'
  if (-not (Test-BundleLayout -Path $sourceBundle)) {
    $pywin32RepairArchive = Resolve-Pywin32RepairArchive -Root $script:ResolvedAppRoot -RequestedArchive $Pywin32RepairArchivePath
    if ($null -eq $pywin32RepairArchive) {
      $missingFiles = (Get-MissingPywin32Files -Path $sourceBundle) -join ', '
      throw "The bundled pywin32 dependency layout is incomplete. Missing: $missingFiles"
    }
    if ((Get-FullPath -Path $sourceBundle) -eq (Get-FullPath -Path $script:ExpectedBundlePath)) {
      $script:StagingPath = Join-Path $pythonParent ('.ali-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
      Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:StagingPath
      Copy-BundleToStaging -Source $sourceBundle -Destination $script:StagingPath
      $sourceBundle = $script:StagingPath
    }
    Expand-Pywin32RepairArchive -ArchivePath $pywin32RepairArchive -Destination $sourceBundle
  }

  if (-not (Test-BundleLayout -Path $sourceBundle)) {
    $missingFiles = (Get-MissingPywin32Files -Path $sourceBundle) -join ', '
    throw "The bundled pywin32 dependency repair is incomplete. Missing: $missingFiles"
  }

  Write-RepairProgress -Step '3/6' -Message 'Validating the 64-bit Python 3.12 runtime...'
  $probePath = Join-Path $script:ResolvedAppRoot 'tools\ali-monthly-report\python_dependency_probe.py'
  if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
    throw "Python dependency probe is missing: $probePath"
  }

  $envLocalPath = Join-Path $script:ResolvedAppRoot '.env.local'
  $envPath = Join-Path $script:ResolvedAppRoot '.env'
  $envLocalLines = Get-DotEnvLines -Path $envLocalPath
  $envLines = Get-DotEnvLines -Path $envPath
  $selectedPython = Select-PythonRuntime -RequestedPython $Python -Root $script:ResolvedAppRoot -BundlePath $sourceBundle -ProbePath $probePath -EnvLocalLines $envLocalLines -EnvLines $envLines -PortableArchive $PortablePythonArchivePath -ForcePortable:$ForcePortablePython

  Write-RepairProgress -Step '4/6' -Message 'Preparing the atomic runtime configuration...'
  $existingPythonPath = Get-DotEnvValue -Lines $envLocalLines -Name 'PYTHONPATH'
  if ([string]::IsNullOrWhiteSpace($existingPythonPath)) {
    $existingPythonPath = Get-DotEnvValue -Lines $envLines -Name 'PYTHONPATH'
  }
  if ([string]::IsNullOrWhiteSpace($existingPythonPath)) {
    $existingPythonPath = $env:PYTHONPATH
  }
  $mergedPythonPath = Merge-PythonPath -BundlePath $script:ExpectedBundlePath -ExistingValue $existingPythonPath
  $newEnvLines = Set-DotEnvValues -Lines $envLocalLines -Values @{
    'ALI_MONTHLY_REPORT_PYTHON' = $selectedPython
    'PYTHONPATH' = $mergedPythonPath
  }

  Write-RepairProgress -Step '5/6' -Message 'Applying the repair and running the final dependency probe...'
  if (-not $NoRestart) {
    Write-RepairSubstep -Substep '1/5' -Message 'Stopping the application service...'
    Invoke-ServiceStop -Root $script:ResolvedAppRoot -TimeoutSeconds $ServiceStopTimeoutSeconds
    $script:ServiceStopped = $true
  }

  Write-RepairSubstep -Substep '2/5' -Message 'Activating the repaired pywin32 bundle...'
  if ((Get-FullPath -Path $sourceBundle) -ne (Get-FullPath -Path $script:ExpectedBundlePath)) {
    if (Test-Path -LiteralPath $script:ExpectedBundlePath) {
      $script:BundleBackupPath = $script:ExpectedBundlePath + '.backup.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
      Move-Item -LiteralPath $script:ExpectedBundlePath -Destination $script:BundleBackupPath
    }
    Move-Item -LiteralPath $script:StagingPath -Destination $script:ExpectedBundlePath
    $script:StagingPath = $null
    $script:BundleChanged = $true
  }

  Write-RepairSubstep -Substep '3/5' -Message 'Writing the Python runtime configuration...'
  Write-DotEnvAtomically -Path $envLocalPath -Lines $newEnvLines
  Write-RepairSubstep -Substep '4/5' -Message 'Validating pythoncom and win32com.client...'
  if (-not (Test-PythonRuntime -Candidate $selectedPython -BundlePath $script:ExpectedBundlePath -ProbePath $probePath)) {
    throw 'Final Python COM dependency validation failed.'
  }

  if (-not $NoRestart) {
    Write-RepairSubstep -Substep '5/5' -Message "Starting the application service (timeout: $ServiceStartTimeoutSeconds seconds)..."
    Invoke-ServiceStart -Root $script:ResolvedAppRoot -TimeoutSeconds $ServiceStartTimeoutSeconds
    $script:ServiceStopped = $false
  }

  Write-RepairProgress -Step '6/6' -Message 'Repair completed successfully.'
  Write-Output 'REPAIR_READY'
  Write-Output ('APP_ROOT=' + $script:ResolvedAppRoot)
  Write-Output ('PYTHON=' + $selectedPython)
  Write-Output ('BUNDLE=' + $script:ExpectedBundlePath)
  if ($null -ne $script:EnvBackupPath) {
    Write-Output ('ENV_BACKUP=' + $script:EnvBackupPath)
  }
  if ($null -ne $script:BundleBackupPath) {
    Write-Output ('BUNDLE_BACKUP=' + $script:BundleBackupPath)
  }
} catch {
  $message = $_.Exception.Message
  if ($script:ServiceStopped) {
    try {
      Invoke-ServiceStop -Root $script:ResolvedAppRoot -TimeoutSeconds $ServiceStopTimeoutSeconds
    } catch {
      $message = $message + ' Failed to stop the partial repaired service: ' + $_.Exception.Message
    }
  }
  try {
    Restore-Changes
  } catch {
    $message = $message + ' Rollback also failed: ' + $_.Exception.Message
  }
  if ($script:ServiceStopped) {
    try {
      Invoke-ServiceStart -Root $script:ResolvedAppRoot -TimeoutSeconds $RollbackStartTimeoutSeconds
      $script:ServiceStopped = $false
    } catch {
      $message = $message + ' Failed to restart the previous service after rollback: ' + $_.Exception.Message
    }
  }
  Write-Error $message
  exit 1
} finally {
  if ($null -ne $script:EnvTempPath -and (Test-Path -LiteralPath $script:EnvTempPath)) {
    Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:EnvTempPath
    Remove-Item -LiteralPath $script:EnvTempPath -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $script:StagingPath -and (Test-Path -LiteralPath $script:StagingPath)) {
    Assert-ChildPath -Parent $script:ResolvedAppRoot -Child $script:StagingPath
    Remove-Item -LiteralPath $script:StagingPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}
