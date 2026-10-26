param(
  [string]$AppRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($AppRoot)
$envFile = Join-Path $root '.env'
$localFile = Join-Path $root '.env.local'
$rolePattern = 'LOCAL_(?:ADMIN|EDITOR|PURCHASE_ADMIN|CONSTRUCTION_ADMIN|INVENTORY_ADMIN_[ABCDEH]|PURCHASE_APPLICANT_[ABCDEH]|BUILDING_ADMIN_(?:[ABCDE]|110))_PASSWORD_HASH'
$settingPattern = [regex]::new("(?m)^[ \t]*(?:export[ \t]+)?(?<name>$rolePattern)[ \t]*=[ \t]*(?<value>[^\r\n]*)")
$linePattern = [regex]::new("(?m)^[ \t]*(?:export[ \t]+)?(?<name>$rolePattern)[ \t]*=[^\r\n]*(?:\r\n|\n|\r|$)")
$utf8 = [Text.UTF8Encoding]::new($false, $true)

function Read-Utf8File {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
  $offset = if ($bom) { 3 } else { 0 }
  return @{ Text = $utf8.GetString($bytes, $offset, $bytes.Length - $offset); Bom = $bom }
}

if (!(Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Missing .env; no file was changed.' }
if (!(Test-Path -LiteralPath $localFile -PathType Leaf)) { throw 'Missing .env.local; no file was changed.' }

$base = Read-Utf8File $envFile
$names = @{}
foreach ($match in $settingPattern.Matches($base.Text)) {
  $name = $match.Groups['name'].Value
  if ($names.ContainsKey($name)) { throw "Duplicate hash in .env: $name. No file was changed." }
  if ($match.Groups['value'].Value.Trim() -notmatch '^scrypt\$[^$]+\$[^$]+$') {
    throw "Invalid hash in .env: $name. No file was changed."
  }
  $names[$name] = $true
}
if ($names.Count -ne 22) { throw "Expected 22 role hashes in .env; found $($names.Count). No file was changed." }

$local = Read-Utf8File $localFile
$found = @($linePattern.Matches($local.Text))
if ($found.Count -eq 0) {
  Write-Host 'No role password overrides found in .env.local. No file was changed.'
  exit 0
}
$updated = $linePattern.Replace($local.Text, '')
$backup = "$localFile.password-backup-$(Get-Date -Format 'yyyyMMddHHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$temporary = "$localFile.password-repair-$([guid]::NewGuid().ToString('N')).tmp"
$content = $utf8.GetBytes($updated)
if ($local.Bom) { $content = [byte[]]@(239, 187, 191) + $content }

try {
  [IO.File]::WriteAllBytes($temporary, $content)
  [IO.File]::Move($localFile, $backup)
  try {
    [IO.File]::Move($temporary, $localFile)
  } catch {
    [IO.File]::Move($backup, $localFile)
    throw
  }
} finally {
  if (Test-Path -LiteralPath $temporary -PathType Leaf) {
    Remove-Item -LiteralPath $temporary -Force
  }
}

Write-Host "Removed $($found.Count) role password overrides from .env.local."
Write-Host "Backup: $backup"
Write-Host 'Restart the application, then test a new password in a private browser window.'
