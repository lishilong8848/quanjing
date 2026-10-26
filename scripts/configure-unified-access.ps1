param(
  [ValidateSet('user', 'env')]
  [string]$Target = 'user',
  [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeScript = Join-Path $PSScriptRoot 'configure-unified-access.mjs'

function ConvertTo-PlainText {
  param([Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$adminSecure = Read-Host 'Administrator access password' -AsSecureString
$editorSecure = Read-Host 'Editor access password' -AsSecureString

try {
  $env:LOCAL_ADMIN_SETUP_PASSWORD = ConvertTo-PlainText $adminSecure
  $env:LOCAL_EDITOR_SETUP_PASSWORD = ConvertTo-PlainText $editorSecure

  $arguments = @('--', $nodeScript, "--target=$Target")
  if ($Target -eq 'env') {
    $arguments += "--env-file=$EnvFile"
  }

  & $nodeCommand.Source @arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'Unified access configuration failed.'
  }
} finally {
  Remove-Item Env:LOCAL_ADMIN_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_EDITOR_SETUP_PASSWORD -ErrorAction SilentlyContinue
  $adminSecure = $null
  $editorSecure = $null
}
