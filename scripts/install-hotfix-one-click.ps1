[CmdletBinding()]
param(
  [string]$AppRoot = $PSScriptRoot,
  [switch]$UpdateDingTalkCredentials
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Test-ApplicationRootCandidate {
  param([string]$Root)

  if ([string]::IsNullOrWhiteSpace($Root)) {
    return $false
  }
  try {
    $candidate = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  } catch {
    return $false
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
    return $false
  }
  foreach ($relativePath in @(
    'package.json',
    'start.ps1',
    'dist/server/main.js',
    'node_modules'
  )) {
    $requiredPath = Join-Path $candidate $relativePath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      return $false
    }
  }
  return $true
}

function Resolve-ApplicationRoot {
  param([string]$RequestedRoot)

  if (Test-ApplicationRootCandidate -Root $RequestedRoot) {
    return [System.IO.Path]::GetFullPath($RequestedRoot).TrimEnd('\', '/')
  }

  $configuredRoot = [Environment]::GetEnvironmentVariable(
    'NANTONG_APP_ROOT',
    [EnvironmentVariableTarget]::Process
  )
  if (-not [string]::IsNullOrWhiteSpace($configuredRoot)) {
    if (-not (Test-ApplicationRootCandidate -Root $configuredRoot)) {
      throw 'NANTONG_APP_ROOT does not point to a valid application root. No files were changed.'
    }
    $resolvedConfiguredRoot = [System.IO.Path]::GetFullPath($configuredRoot).TrimEnd('\', '/')
    Write-Host "[INFO] Using application root: $resolvedConfiguredRoot"
    return $resolvedConfiguredRoot
  }

  $candidateSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $knownRoot = 'C:\ai\nantong-schedule-20260428-101724'
  if (Test-ApplicationRootCandidate -Root $knownRoot) {
    [void]$candidateSet.Add([System.IO.Path]::GetFullPath($knownRoot).TrimEnd('\', '/'))
  }
  $driveRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($PSScriptRoot))
  $applicationParent = Join-Path $driveRoot 'ai'
  if (Test-Path -LiteralPath $applicationParent -PathType Container) {
    foreach ($directory in Get-ChildItem -LiteralPath $applicationParent -Directory -Filter 'nantong-schedule-*' -ErrorAction SilentlyContinue) {
      if (Test-ApplicationRootCandidate -Root $directory.FullName) {
        [void]$candidateSet.Add([System.IO.Path]::GetFullPath($directory.FullName).TrimEnd('\', '/'))
      }
    }
  }
  $candidates = @($candidateSet)
  if ($candidates.Count -eq 1) {
    Write-Host "[INFO] Using application root: $($candidates[0])"
    return $candidates[0]
  }
  if ($candidates.Count -gt 1) {
    throw "Multiple application roots were found under $applicationParent. Extract this package into the intended application root or set NANTONG_APP_ROOT. No files were changed."
  }
  throw "Application root could not be located from '$RequestedRoot'. Expected package.json, start.ps1, dist/server/main.js, and node_modules. No files were changed."
}

function Resolve-NodeExecutable {
  param([string]$Root)

  $pidPath = Join-Path $Root 'app.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    try {
      $pidText = [System.IO.File]::ReadAllText($pidPath, $utf8NoBom).Trim()
      $runtimePid = if ($pidText -match '^\d+$') {
        [int]$pidText
      } else {
        [int](($pidText | ConvertFrom-Json -ErrorAction Stop).pid)
      }
      $runtimeProcess = Get-Process -Id $runtimePid -ErrorAction Stop
      if (
        $runtimeProcess.ProcessName -eq 'node' -and
        -not [string]::IsNullOrWhiteSpace([string]$runtimeProcess.Path) -and
        (Test-Path -LiteralPath $runtimeProcess.Path -PathType Leaf)
      ) {
        return [System.IO.Path]::GetFullPath($runtimeProcess.Path)
      }
    } catch {
      # Fall through to the stable runtime locations below.
    }
  }

  $portableNode = Join-Path $Root '.runtime\node\node.exe'
  if (Test-Path -LiteralPath $portableNode -PathType Leaf) {
    return [System.IO.Path]::GetFullPath($portableNode)
  }

  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode -and (Test-Path -LiteralPath $pathNode.Source -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($pathNode.Source)
  }

  throw 'Node.js runtime was not found in app.pid, .runtime\node, or PATH. No files were changed.'
}

function Invoke-DingTalkCliProbe {
  param(
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [string[]]$SensitiveValues = @()
  )

  if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    throw "DingTalk CLI is missing: $CliPath"
  }

  $output = @()
  $exitCode = -1
  Push-Location $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $NodePath $CliPath --self-test 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  foreach ($line in $output) {
    $safeLine = [string]$line
    foreach ($sensitiveValue in $SensitiveValues) {
      if (-not [string]::IsNullOrEmpty($sensitiveValue)) {
        $safeLine = $safeLine.Replace($sensitiveValue, '[REDACTED]')
      }
    }
    Write-Host $safeLine
  }

  return [pscustomobject]@{
    exitCode = $exitCode
    output = @($output)
  }
}

function Invoke-DingTalkCliSelfTest {
  param(
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [string]$Phase,
    [string]$CredentialRoot = '',
    [switch]$AllowCredentialRetry
  )

  $configuredSensitiveValues = @(
    [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_CLIENT_ID', [EnvironmentVariableTarget]::Process),
    [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_CLIENT_SECRET', [EnvironmentVariableTarget]::Process),
    [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_APP_KEY', [EnvironmentVariableTarget]::Process),
    [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_APP_SECRET', [EnvironmentVariableTarget]::Process)
  )
  $probe = Invoke-DingTalkCliProbe `
    -NodePath $NodePath `
    -CliPath $CliPath `
    -WorkingDirectory $WorkingDirectory `
    -SensitiveValues $configuredSensitiveValues
  if ($probe.exitCode -eq 0) {
    return
  }
  if (
    $AllowCredentialRetry -and
    (Test-DingTalkCredentialAuthenticationFailure -Output $probe.output)
  ) {
    Write-Host '[WARN] DingTalk rejected the configured attendance credentials. Enter a matching Client ID and Client Secret from the same DingTalk app.' -ForegroundColor Yellow
    $candidate = Read-DingTalkAttendanceCredentialCandidate
    if (-not (Test-DingTalkCredentialCandidate `
      -NodePath $NodePath `
      -CliPath $CliPath `
      -WorkingDirectory $WorkingDirectory `
      -Credential $candidate
    )) {
      throw 'The replacement DingTalk credentials were rejected. Existing credentials were preserved and no runtime update was accepted.'
    }
    Save-DingTalkAttendanceCredentials `
      -Root $CredentialRoot `
      -ClientId $candidate.clientId `
      -ClientSecret $candidate.clientSecret
    Write-Host '[OK] Replacement DingTalk credentials were validated and saved.' -ForegroundColor Green
    return
  }
  if ($Phase -ceq 'pre-install') {
    throw "DingTalk CLI pre-install self-test failed with exit code $($probe.exitCode). No runtime update was accepted."
  }
  throw "DingTalk CLI $Phase self-test failed with exit code $($probe.exitCode) after the runtime health check passed."
}

function Get-DotEnvValue {
  param(
    [string]$FilePath,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return ''
  }
  $line = Get-Content -LiteralPath $FilePath -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -Last 1
  if (-not $line) {
    return ''
  }
  $value = ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", '').Trim()
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value.Trim()
}

function Set-DotEnvValue {
  param(
    [AllowEmptyString()][string]$Content,
    [string]$Name,
    [string]$Value
  )

  $line = $Name + '=' + (ConvertTo-Json -Compress $Value)
  $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '\s*=.*(?:\r?\n|$)'
  if ([regex]::IsMatch($Content, $pattern)) {
    $contentWithoutDuplicates = [regex]::Replace($Content, $pattern, '')
    if ($contentWithoutDuplicates.Length -gt 0 -and -not $contentWithoutDuplicates.EndsWith("`n")) {
      $contentWithoutDuplicates += "`r`n"
    }
    return $contentWithoutDuplicates + $line + "`r`n"
  }
  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) {
    $Content += "`r`n"
  }
  return $Content + $line + "`r`n"
}

function Write-Utf8Atomic {
  param(
    [string]$Path,
    [string]$Content
  )

  $directory = Split-Path -Parent $Path
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporaryPath = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $backupPath = $Path + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
  $lockPath = $Path + '.lock'
  $lockStream = $null
  try {
    $lockStream = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $bytes = $utf8NoBom.GetBytes($Content)
    $stream = [System.IO.FileStream]::new(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [System.IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
    } else {
      [System.IO.File]::Move($temporaryPath, $Path)
    }
  } finally {
    if ($null -ne $lockStream) {
      $lockStream.Dispose()
    }
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
    if (Test-Path -LiteralPath $backupPath) {
      Remove-Item -LiteralPath $backupPath -Force
    }
  }
}

function Save-DingTalkAttendanceCredentials {
  param(
    [string]$Root,
    [string]$ClientId,
    [string]$ClientSecret
  )

  $environmentPath = Join-Path $Root '.env.local'
  $content = if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($environmentPath, [Text.Encoding]::UTF8)
  } else {
    ''
  }
  $content = Set-DotEnvValue $content 'DINGTALK_ATTENDANCE_CLIENT_ID' $ClientId
  $content = Set-DotEnvValue $content 'DINGTALK_ATTENDANCE_CLIENT_SECRET' $ClientSecret
  $content = Set-DotEnvValue $content 'ATTENDANCE_AUTOMATION_ENABLED' 'true'
  $content = Set-DotEnvValue $content 'ATTENDANCE_AUTOMATION_EFFECTIVE_FROM' '2026-08-28'
  $content = Set-DotEnvValue $content 'ATTENDANCE_AUTOMATION_LOOKBACK_DAYS' '0'
  $content = Set-DotEnvValue $content 'ATTENDANCE_AUTOMATION_LIVE_CATCHUP_MINUTES' '30'
  Write-Utf8Atomic -Path $environmentPath -Content $content
  [Environment]::SetEnvironmentVariable(
    'DINGTALK_ATTENDANCE_CLIENT_ID',
    $ClientId,
    [EnvironmentVariableTarget]::Process
  )
  [Environment]::SetEnvironmentVariable(
    'DINGTALK_ATTENDANCE_CLIENT_SECRET',
    $ClientSecret,
    [EnvironmentVariableTarget]::Process
  )
}

function Read-ConsoleValue {
  param(
    [string]$Prompt,
    [switch]$Secret
  )

  Write-Host $Prompt -NoNewline
  if ([Console]::IsInputRedirected) {
    $line = [Console]::In.ReadLine()
    Write-Host ''
    if ($null -eq $line) {
      return ''
    }
    return $line.Trim()
  }
  if (-not $Secret) {
    return ([Console]::ReadLine()).Trim()
  }

  $value = New-Object System.Text.StringBuilder
  while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) {
      Write-Host ''
      break
    }
    if ($key.Key -eq [ConsoleKey]::Backspace) {
      if ($value.Length -gt 0) {
        [void]$value.Remove($value.Length - 1, 1)
        Write-Host "`b `b" -NoNewline
      }
      continue
    }
    if (-not [char]::IsControl($key.KeyChar)) {
      [void]$value.Append($key.KeyChar)
      Write-Host '*' -NoNewline
    }
  }
  return $value.ToString().Trim()
}

function Test-DingTalkCredentialAuthenticationFailure {
  param([object[]]$Output)

  $message = (@($Output) | ForEach-Object { [string]$_ }) -join "`n"
  return $message -match '(?i)(Specified parameter\s+(appSecret|appKey|clientSecret|clientId)\s+is not valid|Missing DingTalk attendance credentials in environment variables)'
}

function Read-DingTalkAttendanceCredentialCandidate {
  Write-Host '[INFO] Secret characters are shown as * and must be entered twice.'
  $clientId = Read-ConsoleValue -Prompt 'DingTalk Client ID: '
  if ([string]::IsNullOrWhiteSpace($clientId)) {
    throw 'DingTalk Client ID was not entered. No runtime files were changed.'
  }

  $clientSecret = ''
  $confirmation = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $candidate = Read-ConsoleValue -Prompt 'DingTalk Client Secret: ' -Secret
    Write-Host "[INFO] Client Secret received: $($candidate.Length) characters (value hidden)."
    $confirmation = Read-ConsoleValue -Prompt 'DingTalk Client Secret (confirm): ' -Secret
    Write-Host "[INFO] Confirmation received: $($confirmation.Length) characters (value hidden)."
    if (
      -not [string]::IsNullOrWhiteSpace($candidate) -and
      [string]::Equals($candidate, $confirmation, [StringComparison]::Ordinal)
    ) {
      $clientSecret = $candidate
      break
    }
    $candidate = ''
    $confirmation = ''
    Write-Host '[WARN] Secret entries did not match or were empty. Re-enter the Client Secret.' -ForegroundColor Yellow
  }
  if ([string]::IsNullOrWhiteSpace($clientSecret)) {
    throw 'DingTalk Client Secret confirmation failed. No runtime files were changed.'
  }

  return [pscustomobject]@{
    clientId = $clientId
    clientSecret = $clientSecret
  }
}

function Test-DingTalkCredentialCandidate {
  param(
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [object]$Credential
  )

  $credentialNames = @(
    'DINGTALK_ATTENDANCE_CLIENT_ID',
    'DINGTALK_ATTENDANCE_CLIENT_SECRET',
    'DINGTALK_ATTENDANCE_APP_KEY',
    'DINGTALK_ATTENDANCE_APP_SECRET'
  )
  $previousValues = @{}
  foreach ($name in $credentialNames) {
    $previousValues[$name] = [Environment]::GetEnvironmentVariable(
      $name,
      [EnvironmentVariableTarget]::Process
    )
  }
  try {
    [Environment]::SetEnvironmentVariable(
      'DINGTALK_ATTENDANCE_CLIENT_ID',
      $Credential.clientId,
      [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
      'DINGTALK_ATTENDANCE_CLIENT_SECRET',
      $Credential.clientSecret,
      [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
      'DINGTALK_ATTENDANCE_APP_KEY',
      $null,
      [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
      'DINGTALK_ATTENDANCE_APP_SECRET',
      $null,
      [EnvironmentVariableTarget]::Process
    )
    $probe = Invoke-DingTalkCliProbe `
      -NodePath $NodePath `
      -CliPath $CliPath `
      -WorkingDirectory $WorkingDirectory `
      -SensitiveValues @($Credential.clientId, $Credential.clientSecret)
    return $probe.exitCode -eq 0
  } finally {
    foreach ($name in $credentialNames) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $previousValues[$name],
        [EnvironmentVariableTarget]::Process
      )
    }
  }
}

function Get-DingTalkCredentialPairFromFile {
  param(
    [string]$Path,
    [string]$Source
  )

  $clientId = Get-DotEnvValue -FilePath $Path -Name 'DINGTALK_ATTENDANCE_CLIENT_ID'
  if ([string]::IsNullOrWhiteSpace($clientId)) {
    $clientId = Get-DotEnvValue -FilePath $Path -Name 'DINGTALK_ATTENDANCE_APP_KEY'
  }
  $clientSecret = Get-DotEnvValue -FilePath $Path -Name 'DINGTALK_ATTENDANCE_CLIENT_SECRET'
  if ([string]::IsNullOrWhiteSpace($clientSecret)) {
    $clientSecret = Get-DotEnvValue -FilePath $Path -Name 'DINGTALK_ATTENDANCE_APP_SECRET'
  }
  if ([string]::IsNullOrWhiteSpace($clientId) -and [string]::IsNullOrWhiteSpace($clientSecret)) {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
    throw "DingTalk credentials are incomplete in $Source. Client ID and Client Secret must come from the same source."
  }
  return [pscustomobject]@{
    clientId = $clientId
    clientSecret = $clientSecret
    source = $Source
  }
}

function Get-DingTalkCredentialPairFromEnvironment {
  param(
    [EnvironmentVariableTarget]$Scope,
    [string]$Source
  )

  $clientId = [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_CLIENT_ID', $Scope)
  if ([string]::IsNullOrWhiteSpace($clientId)) {
    $clientId = [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_APP_KEY', $Scope)
  }
  $clientSecret = [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_CLIENT_SECRET', $Scope)
  if ([string]::IsNullOrWhiteSpace($clientSecret)) {
    $clientSecret = [Environment]::GetEnvironmentVariable('DINGTALK_ATTENDANCE_APP_SECRET', $Scope)
  }
  if ([string]::IsNullOrWhiteSpace($clientId) -and [string]::IsNullOrWhiteSpace($clientSecret)) {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
    throw "DingTalk credentials are incomplete in $Source. Client ID and Client Secret must come from the same source."
  }
  return [pscustomobject]@{
    clientId = $clientId
    clientSecret = $clientSecret
    source = $Source
  }
}

function Test-DingTalkAttendanceCredentialsAvailable {
  param([string]$Root)

  $pair = $null
  foreach ($fileSource in @(
    [pscustomobject]@{ path = (Join-Path $Root '.env.local'); label = '.env.local' },
    [pscustomobject]@{ path = (Join-Path $Root '.env'); label = '.env' },
    [pscustomobject]@{ path = (Join-Path (Split-Path -Parent $Root) 'nantong-schedule.private.env'); label = 'nantong-schedule.private.env' }
  )) {
    $pair = Get-DingTalkCredentialPairFromFile -Path $fileSource.path -Source $fileSource.label
    if ($null -ne $pair) {
      break
    }
  }
  if ($null -eq $pair) {
    foreach ($scopeSource in @(
      [pscustomobject]@{ scope = [EnvironmentVariableTarget]::Process; label = 'Process environment' },
      [pscustomobject]@{ scope = [EnvironmentVariableTarget]::User; label = 'User environment' },
      [pscustomobject]@{ scope = [EnvironmentVariableTarget]::Machine; label = 'Machine environment' }
    )) {
      $pair = Get-DingTalkCredentialPairFromEnvironment -Scope $scopeSource.scope -Source $scopeSource.label
      if ($null -ne $pair) {
        break
      }
    }
  }
  if ($null -eq $pair) {
    return $false
  }
  [Environment]::SetEnvironmentVariable(
    'DINGTALK_ATTENDANCE_CLIENT_ID',
    $pair.clientId,
    [EnvironmentVariableTarget]::Process
  )
  [Environment]::SetEnvironmentVariable(
    'DINGTALK_ATTENDANCE_CLIENT_SECRET',
    $pair.clientSecret,
    [EnvironmentVariableTarget]::Process
  )
  return $true
}

function Test-LegacyDingTalkAttachment {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  $source = [System.IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  return (
    $source -match '(?m)^\s*CLIENT_ID\s*=\s*([''"]).+?\1\s*$' -and
    $source -match '(?m)^\s*CLIENT_SECRET\s*=\s*([''"]).+?\1\s*$'
  )
}

function Resolve-LegacyDingTalkAttachment {
  param([string]$Root)

  $userProfile = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::UserProfile
  )
  $candidates = @(
    (Join-Path $Root 'dingtalk_attendance.py'),
    (Join-Path (Join-Path $Root 'scripts') 'dingtalk_attendance.py')
  )
  if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
    $candidates += Join-Path `
      (Join-Path $userProfile 'Downloads') `
      'dingtalk_attendance.py'
  }
  foreach ($candidate in $candidates) {
    if (Test-LegacyDingTalkAttachment -Path $candidate) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  return ''
}

function Read-LegacyDingTalkCredentialCandidate {
  param([string]$Path)

  $source = [System.IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  $values = @{}
  foreach ($name in @('CLIENT_ID', 'CLIENT_SECRET')) {
    $pattern = '^\s*' + [regex]::Escape($name) + '\s*=\s*([''"])(?<value>.*?)\1\s*$'
    $match = [regex]::Match(
      $source,
      $pattern,
      [Text.RegularExpressions.RegexOptions]::Multiline
    )
    if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups['value'].Value)) {
      throw "Legacy DingTalk attachment does not contain a usable $name value. No files were changed."
    }
    $values[$name] = $match.Groups['value'].Value.Trim()
  }
  return [pscustomobject]@{
    clientId = $values.CLIENT_ID
    clientSecret = $values.CLIENT_SECRET
  }
}

function Initialize-DingTalkAttendanceCredentials {
  param(
    [string]$Root,
    [string]$MigrationPath,
    [string]$NodePath,
    [string]$CliPath,
    [string]$WorkingDirectory,
    [switch]$ForceUpdate
  )

  if ($ForceUpdate) {
    Write-Host '[INFO] Updating DingTalk attendance credentials. Existing credentials remain active unless the new pair passes API validation.'
    $candidate = Read-DingTalkAttendanceCredentialCandidate
    if (-not (Test-DingTalkCredentialCandidate `
      -NodePath $NodePath `
      -CliPath $CliPath `
      -WorkingDirectory $WorkingDirectory `
      -Credential $candidate
    )) {
      throw 'The new DingTalk credentials were rejected. Existing credentials were preserved and no runtime files were changed.'
    }
    Save-DingTalkAttendanceCredentials `
      -Root $Root `
      -ClientId $candidate.clientId `
      -ClientSecret $candidate.clientSecret
    Write-Host '[OK] New DingTalk attendance credentials were validated and saved.' -ForegroundColor Green
    return $true
  }

  if (Test-DingTalkAttendanceCredentialsAvailable -Root $Root) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $MigrationPath -PathType Leaf)) {
    throw 'DingTalk credential migration tool is missing. No runtime files were changed.'
  }
  $attachmentPath = Resolve-LegacyDingTalkAttachment -Root $Root
  if ([string]::IsNullOrWhiteSpace($attachmentPath)) {
    Write-Host '[INFO] DingTalk attendance credentials are required once.'
    $candidate = Read-DingTalkAttendanceCredentialCandidate
    if (-not (Test-DingTalkCredentialCandidate `
      -NodePath $NodePath `
      -CliPath $CliPath `
      -WorkingDirectory $WorkingDirectory `
      -Credential $candidate
    )) {
      throw 'The entered DingTalk credentials were rejected. No credentials or runtime files were changed.'
    }
    Save-DingTalkAttendanceCredentials `
      -Root $Root `
      -ClientId $candidate.clientId `
      -ClientSecret $candidate.clientSecret
    Write-Host '[OK] DingTalk attendance credentials were validated and saved.' -ForegroundColor Green
    return $true
  }

  Write-Host '[INFO] Validating DingTalk attendance credentials from the legacy attachment before importing them...'
  $candidate = Read-LegacyDingTalkCredentialCandidate -Path $attachmentPath
  if (-not (Test-DingTalkCredentialCandidate `
    -NodePath $NodePath `
    -CliPath $CliPath `
    -WorkingDirectory $WorkingDirectory `
    -Credential $candidate
  )) {
    throw 'The legacy DingTalk credentials were rejected. The attachment and runtime configuration were not changed.'
  }

  $environmentPath = Join-Path $Root '.env.local'
  $environmentExisted = Test-Path -LiteralPath $environmentPath -PathType Leaf
  $environmentBytes = if ($environmentExisted) {
    [System.IO.File]::ReadAllBytes($environmentPath)
  } else {
    $null
  }
  $attachmentBytes = [System.IO.File]::ReadAllBytes($attachmentPath)
  try {
    & $MigrationPath `
      -AttachmentPath $attachmentPath `
      -EnvironmentFile $environmentPath `
      -EffectiveFrom '2026-08-28' |
      ForEach-Object { Write-Host ([string]$_) }
    Save-DingTalkAttendanceCredentials `
      -Root $Root `
      -ClientId $candidate.clientId `
      -ClientSecret $candidate.clientSecret
  } catch {
    [System.IO.File]::WriteAllBytes($attachmentPath, $attachmentBytes)
    if ($environmentExisted) {
      [System.IO.File]::WriteAllBytes($environmentPath, $environmentBytes)
    } elseif (Test-Path -LiteralPath $environmentPath) {
      Remove-Item -LiteralPath $environmentPath -Force
    }
    throw
  }
  Write-Host '[OK] DingTalk attendance credentials were imported into .env.local.' -ForegroundColor Green
  return $true
}

function Invoke-HotfixActivationCheck {
  param([string]$NodePath, [string]$VerifierPath, [string]$Root, [string]$PackageRoot)
  if (-not (Test-Path -LiteralPath $VerifierPath -PathType Leaf)) {
    throw 'Final application activation verifier is missing.'
  }
  & $NodePath $VerifierPath '--app-root' $Root '--package-root' $PackageRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Final application activation check failed (exit code $LASTEXITCODE). The runtime commit is preserved; diagnose before recovery."
  }
}

$appRootPath = Resolve-ApplicationRoot -RequestedRoot $AppRoot

$payloadRoot = Join-Path $PSScriptRoot '_hotfix-payload'
$payloadZip = Join-Path $payloadRoot 'hotfix-package.zip'
$payloadShaPath = "$payloadZip.sha256"
foreach ($requiredPayloadPath in @($payloadZip, $payloadShaPath)) {
  if (-not (Test-Path -LiteralPath $requiredPayloadPath -PathType Leaf)) {
    throw "One-click payload is incomplete: $requiredPayloadPath"
  }
}

$declaredShaText = [System.IO.File]::ReadAllText($payloadShaPath, $utf8NoBom).Trim()
if ($declaredShaText -notmatch '^(?<sha>[0-9a-fA-F]{64})(?:\s|$)') {
  throw 'One-click payload SHA-256 file is invalid. No files were changed.'
}
$declaredSha = $Matches.sha.ToLowerInvariant()
$actualSha = (Get-FileHash -LiteralPath $payloadZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha -cne $declaredSha) {
  throw 'One-click payload SHA-256 does not match. No files were changed.'
}

$tempRoot = Join-Path `
  ([System.IO.Path]::GetTempPath()) `
  "nantong-one-click-hotfix-$([Guid]::NewGuid().ToString('N'))"
$installerStarted = $false
$installerCompleted = $false
$activationCompleted = $false
try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $tempRoot

  $installerPath = Join-Path $tempRoot 'INSTALL-HOTFIX.ps1'
  $candidateCliPath = Join-Path $tempRoot 'release-root\scripts\dingtalk-attendance-cli.mjs'
  $credentialMigrationPath = Join-Path `
    $tempRoot `
    'release-root\scripts\migrate-dingtalk-attendance-credentials.ps1'
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw 'Embedded hotfix installer is missing. No files were changed.'
  }

  $nodePath = Resolve-NodeExecutable -Root $appRootPath
  $candidateManifest = Get-Content -Raw -LiteralPath (Join-Path $tempRoot 'hotfix-manifest.json') | ConvertFrom-Json
  $activationVerifierPath = Join-Path $tempRoot 'release-root\scripts\verify-hotfix-activation.cjs'
  if (-not (Test-Path -LiteralPath $activationVerifierPath -PathType Leaf)) {
    throw 'Candidate application activation verifier is missing. No runtime files were changed.'
  }
  $actualNodeSha = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([string]$candidateManifest.buildNodeSha256 -cne $actualNodeSha) {
    throw 'Selected Node runtime does not match the frozen candidate. No runtime files were changed.'
  }
  $credentialsAlreadyValidated = Initialize-DingTalkAttendanceCredentials `
    -Root $appRootPath `
    -MigrationPath $credentialMigrationPath `
    -NodePath $nodePath `
    -CliPath $candidateCliPath `
    -WorkingDirectory $appRootPath `
    -ForceUpdate:$UpdateDingTalkCredentials
  if (-not $credentialsAlreadyValidated) {
    Write-Host '[INFO] Checking DingTalk credentials and APIs before changing runtime files...'
    Invoke-DingTalkCliSelfTest `
      -NodePath $nodePath `
      -CliPath $candidateCliPath `
      -WorkingDirectory $appRootPath `
      -Phase 'pre-install' `
      -CredentialRoot $appRootPath `
      -AllowCredentialRetry
  }

  Write-Host '[INFO] DingTalk preflight passed. Starting atomic hotfix installation...'
  $installerArguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    "`"$installerPath`"",
    '-AppRoot',
    "`"$appRootPath`""
  ) -join ' '
  $installerStarted = $true
  $installerProcess = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList $installerArguments `
    -WorkingDirectory $tempRoot `
    -NoNewWindow `
    -Wait `
    -PassThru
  $installerProcess.Refresh()
  if ($installerProcess.ExitCode -ne 0) {
    throw "Atomic hotfix installer failed with exit code $($installerProcess.ExitCode)."
  }
  $installerCompleted = $true

  Write-Host '[INFO] Runtime installation completed. Waiting for application activation...'
  $activationNodePath = Resolve-NodeExecutable -Root $appRootPath
  Invoke-HotfixActivationCheck `
    -NodePath $activationNodePath `
    -VerifierPath $activationVerifierPath `
    -Root $appRootPath `
    -PackageRoot $tempRoot
  $activationCompleted = $true

  Write-Host '[INFO] Runtime health passed; installed release integrity was verified by the atomic installer.'
  Write-Host '[OK] One-click hotfix installation, application activation, and DingTalk preflight passed.' -ForegroundColor Green
} finally {
  if (-not $installerStarted -or ($installerCompleted -and $activationCompleted)) {
    if (Test-Path -LiteralPath $tempRoot) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  } elseif (Test-Path -LiteralPath $tempRoot) {
    Write-Host "[WARN] Installer recovery files were kept for diagnosis: $tempRoot" -ForegroundColor Yellow
  }
}
