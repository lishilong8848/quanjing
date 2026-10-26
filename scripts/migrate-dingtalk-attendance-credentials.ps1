[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AttachmentPath,
  [string]$EnvironmentFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local'),
  [string]$EffectiveFrom = '2026-08-28'
)

$ErrorActionPreference = 'Stop'

function Get-PythonStringAssignment {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*([''"])(?<value>.*?)\1\s*$'
  $match = [regex]::Match(
    $Source,
    $pattern,
    [Text.RegularExpressions.RegexOptions]::Multiline
  )
  if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups['value'].Value)) {
    throw "Attachment does not contain a usable $Name assignment."
  }
  $value = $match.Groups['value'].Value.Trim()
  if ($value.Contains("`r") -or $value.Contains("`n")) {
    throw "$Name contains an invalid line break."
  }
  return $value
}

function Set-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $line = $Name + '=' + (ConvertTo-Json -Compress $Value)
  $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '\s*=.*$'
  if ([regex]::IsMatch($Content, $pattern)) {
    return [regex]::Replace($Content, $pattern, $line, 1)
  }
  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) {
    $Content += "`r`n"
  }
  return $Content + $line + "`r`n"
}

function Write-Utf8Atomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  $temporaryPath = $Path + '.' + $PID + '.' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.tmp'
  try {
    [IO.File]::WriteAllText($temporaryPath, $Content, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

if (-not (Test-Path -LiteralPath $AttachmentPath -PathType Leaf)) {
  throw 'DingTalk attendance attachment was not found.'
}
if ($EffectiveFrom -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw 'EffectiveFrom must use YYYY-MM-DD.'
}

$source = [IO.File]::ReadAllText($AttachmentPath, [Text.Encoding]::UTF8)
$clientId = Get-PythonStringAssignment -Source $source -Name 'CLIENT_ID'
$clientSecret = Get-PythonStringAssignment -Source $source -Name 'CLIENT_SECRET'

$environment = if (Test-Path -LiteralPath $EnvironmentFile) {
  [IO.File]::ReadAllText($EnvironmentFile, [Text.Encoding]::UTF8)
} else {
  ''
}
$environment = Set-DotEnvValue $environment 'DINGTALK_ATTENDANCE_CLIENT_ID' $clientId
$environment = Set-DotEnvValue $environment 'DINGTALK_ATTENDANCE_CLIENT_SECRET' $clientSecret
$environment = Set-DotEnvValue $environment 'ATTENDANCE_AUTOMATION_ENABLED' 'true'
$environment = Set-DotEnvValue $environment 'ATTENDANCE_AUTOMATION_EFFECTIVE_FROM' $EffectiveFrom
$environment = Set-DotEnvValue $environment 'ATTENDANCE_AUTOMATION_LOOKBACK_DAYS' '0'
$environment = Set-DotEnvValue $environment 'ATTENDANCE_AUTOMATION_LIVE_CATCHUP_MINUTES' '30'
Write-Utf8Atomic -Path $EnvironmentFile -Content $environment

if ($source -notmatch '(?m)^\s*import\s+os\s*$') {
  $source = [regex]::Replace(
    $source,
    '(?m)^(import\s+json\s*\r?\n)',
    ('$1' + 'import os' + [Environment]::NewLine),
    1
  )
}
$source = [regex]::Replace(
  $source,
  '(?m)^\s*CLIENT_ID\s*=\s*([''"]).*?\1\s*$',
  'CLIENT_ID = os.environ.get("DINGTALK_ATTENDANCE_CLIENT_ID", "").strip()',
  1
)
$source = [regex]::Replace(
  $source,
  '(?m)^\s*CLIENT_SECRET\s*=\s*([''"]).*?\1\s*$',
  'CLIENT_SECRET = os.environ.get("DINGTALK_ATTENDANCE_CLIENT_SECRET", "").strip()',
  1
)
Write-Utf8Atomic -Path $AttachmentPath -Content $source

Write-Output 'DingTalk attendance credentials migrated to the ignored environment file.'
Write-Output "Attendance automation enabled from $EffectiveFrom; historical dates before it remain excluded."
Write-Output 'The attachment now reads credentials from environment variables and no longer contains literals.'
