param(
  [ValidateSet('env')]
  [string]$Target = 'env',
  [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeScript = Join-Path $PSScriptRoot 'configure-construction-access.mjs'

function ConvertTo-PlainText {
  param([Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$constructionAdminSecure = Read-Host 'Construction administrator access password' -AsSecureString

try {
  $env:LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD = ConvertTo-PlainText $constructionAdminSecure

  & $nodeCommand.Source '--' $nodeScript "--target=$Target" "--output-env-file=$EnvFile"
  if ($LASTEXITCODE -ne 0) {
    throw 'Construction access configuration failed.'
  }
} finally {
  Remove-Item Env:LOCAL_CONSTRUCTION_ADMIN_SETUP_PASSWORD -ErrorAction SilentlyContinue
  $constructionAdminSecure = $null
}
