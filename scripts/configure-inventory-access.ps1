param(
  [ValidateSet('env')]
  [string]$Target = 'env',
  [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeScript = Join-Path $PSScriptRoot 'configure-inventory-access.mjs'

function ConvertTo-PlainText {
  param([Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$buildingASecure = Read-Host 'Building A inventory administrator access password' -AsSecureString
$buildingBSecure = Read-Host 'Building B inventory administrator access password' -AsSecureString
$buildingCSecure = Read-Host 'Building C inventory administrator access password' -AsSecureString
$buildingDSecure = Read-Host 'Building D inventory administrator access password' -AsSecureString
$buildingESecure = Read-Host 'Building E inventory administrator access password' -AsSecureString
$buildingHSecure = Read-Host 'Building H inventory administrator access password' -AsSecureString

try {
  $env:LOCAL_INVENTORY_ADMIN_A_SETUP_PASSWORD = ConvertTo-PlainText $buildingASecure
  $env:LOCAL_INVENTORY_ADMIN_B_SETUP_PASSWORD = ConvertTo-PlainText $buildingBSecure
  $env:LOCAL_INVENTORY_ADMIN_C_SETUP_PASSWORD = ConvertTo-PlainText $buildingCSecure
  $env:LOCAL_INVENTORY_ADMIN_D_SETUP_PASSWORD = ConvertTo-PlainText $buildingDSecure
  $env:LOCAL_INVENTORY_ADMIN_E_SETUP_PASSWORD = ConvertTo-PlainText $buildingESecure
  $env:LOCAL_INVENTORY_ADMIN_H_SETUP_PASSWORD = ConvertTo-PlainText $buildingHSecure

  & $nodeCommand.Source '--' $nodeScript "--target=$Target" "--env-file=$EnvFile"
  if ($LASTEXITCODE -ne 0) {
    throw 'Inventory access configuration failed.'
  }
} finally {
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_A_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_B_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_C_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_D_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_E_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_INVENTORY_ADMIN_H_SETUP_PASSWORD -ErrorAction SilentlyContinue
  $buildingASecure = $null
  $buildingBSecure = $null
  $buildingCSecure = $null
  $buildingDSecure = $null
  $buildingESecure = $null
  $buildingHSecure = $null
}
