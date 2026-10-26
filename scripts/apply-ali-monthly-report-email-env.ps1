param(
  [string]$EnvPath = '.env',
  [string]$ConfigPath = '',
  [string]$QQEmail = '',
  [string]$AuthCode = '',
  [string]$Recipient = '',
  [string]$PowerAlertConfigPath = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-FromScriptRoot {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }

  if (Test-Path $Path) {
    return (Resolve-Path $Path).Path
  }

  $root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  return (Join-Path $root $Path)
}

function Read-JsonConfig {
  param([string]$Path)

  if (!$Path.Trim()) {
    return @{}
  }

  $resolved = Resolve-FromScriptRoot -Path $Path
  if (!(Test-Path $resolved)) {
    throw "Config file not found: $resolved"
  }

  $json = Get-Content -LiteralPath $resolved -Encoding UTF8 -Raw | ConvertFrom-Json
  $values = @{}
  foreach ($property in $json.PSObject.Properties) {
    $values[$property.Name] = [string]$property.Value
  }
  return $values
}

function Ensure-EnvFile {
  param([string]$Path)

  $resolved = Resolve-FromScriptRoot -Path $Path
  if (!(Test-Path $resolved)) {
    $root = Split-Path -Parent $resolved
    $examplePath = Join-Path $root '.env.example'
    if (Test-Path $examplePath) {
      Copy-Item -LiteralPath $examplePath -Destination $resolved -Force
    } else {
      New-Item -ItemType File -Force -Path $resolved | Out-Null
    }
  }
  return $resolved
}

function Set-EnvValue {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [string]$Key,
    [string]$Value
  )

  if (!$Value.Trim()) {
    return 'skipped'
  }

  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  for ($i = 0; $i -lt $Lines.Count; $i += 1) {
    if ($Lines[$i] -match $pattern) {
      $Lines[$i] = "$Key=$Value"
      return 'updated'
    }
  }

  [void]$Lines.Add("$Key=$Value")
  return 'added'
}

$config = Read-JsonConfig -Path $ConfigPath
$pairs = [ordered]@{
  ALI_MONTHLY_REPORT_QQ_EMAIL = if ($QQEmail.Trim()) { $QQEmail.Trim() } else { [string]$config['qq_email'] }
  ALI_MONTHLY_REPORT_QQ_AUTH_CODE = if ($AuthCode.Trim()) { $AuthCode.Trim() } else { [string]$config['auth_code'] }
  ALI_MONTHLY_REPORT_EMAIL_RECIPIENT = if ($Recipient.Trim()) { $Recipient.Trim() } else { [string]$config['recipient'] }
  ALI_MONTHLY_REPORT_FEISHU_APP_ID = [string]$config['feishu_app_id']
  ALI_MONTHLY_REPORT_FEISHU_APP_SECRET = [string]$config['feishu_app_secret']
  ALI_MONTHLY_REPORT_FEISHU_APP_TOKEN = [string]$config['feishu_app_token']
  ALI_POWER_ALERT_CONFIG_PATH = if ($PowerAlertConfigPath.Trim()) { $PowerAlertConfigPath.Trim() } else { [string]$config['ali_power_alert_config_path'] }
}

if (!$pairs['ALI_MONTHLY_REPORT_QQ_EMAIL'].Trim() -or !$pairs['ALI_MONTHLY_REPORT_QQ_AUTH_CODE'].Trim()) {
  throw 'Missing required email config. Provide -QQEmail and -AuthCode, or pass -ConfigPath pointing to a config.json that contains qq_email and auth_code.'
}

$envFile = Ensure-EnvFile -Path $EnvPath
$lines = New-Object System.Collections.Generic.List[string]
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
  [void]$lines.Add($line)
}

$added = 0
$updated = 0
$skipped = 0
foreach ($key in $pairs.Keys) {
  $status = Set-EnvValue -Lines $lines -Key $key -Value $pairs[$key]
  if ($status -eq 'added') { $added += 1 }
  elseif ($status -eq 'updated') { $updated += 1 }
  else { $skipped += 1 }
}

Set-Content -LiteralPath $envFile -Value $lines -Encoding UTF8

Write-Host "[OK] Ali monthly report email env values merged into: $envFile" -ForegroundColor Green
Write-Host "[OK] Added: $added, updated: $updated, skipped empty optional values: $skipped" -ForegroundColor Green
Write-Host '[NEXT] Restart the service with stop.cmd, then start.cmd.' -ForegroundColor Cyan
