param(
  [ValidateSet('user', 'env')]
  [string]$Target = 'user',
  [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeScript = Join-Path $PSScriptRoot 'configure-purchase-access.mjs'

function ConvertTo-PlainText {
  param([Security.SecureString]$SecureValue)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$purchaseAdminSecure = Read-Host 'Purchase administrator access password' -AsSecureString
$applicantASecure = Read-Host 'Building A purchase applicant access password' -AsSecureString
$applicantBSecure = Read-Host 'Building B purchase applicant access password' -AsSecureString
$applicantCSecure = Read-Host 'Building C purchase applicant access password' -AsSecureString
$applicantDSecure = Read-Host 'Building D purchase applicant access password' -AsSecureString
$applicantESecure = Read-Host 'Building E purchase applicant access password' -AsSecureString
$applicantHSecure = Read-Host 'Building H purchase applicant access password' -AsSecureString

try {
  $env:LOCAL_PURCHASE_ADMIN_SETUP_PASSWORD = ConvertTo-PlainText $purchaseAdminSecure
  $env:LOCAL_PURCHASE_APPLICANT_A_SETUP_PASSWORD = ConvertTo-PlainText $applicantASecure
  $env:LOCAL_PURCHASE_APPLICANT_B_SETUP_PASSWORD = ConvertTo-PlainText $applicantBSecure
  $env:LOCAL_PURCHASE_APPLICANT_C_SETUP_PASSWORD = ConvertTo-PlainText $applicantCSecure
  $env:LOCAL_PURCHASE_APPLICANT_D_SETUP_PASSWORD = ConvertTo-PlainText $applicantDSecure
  $env:LOCAL_PURCHASE_APPLICANT_E_SETUP_PASSWORD = ConvertTo-PlainText $applicantESecure
  $env:LOCAL_PURCHASE_APPLICANT_H_SETUP_PASSWORD = ConvertTo-PlainText $applicantHSecure

  $arguments = @('--', $nodeScript, "--target=$Target")
  if ($Target -eq 'env') {
    $arguments += "--env-file=$EnvFile"
  }

  & $nodeCommand.Source @arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'Purchase access configuration failed.'
  }
} finally {
  Remove-Item Env:LOCAL_PURCHASE_ADMIN_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_A_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_B_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_C_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_D_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_E_SETUP_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_PURCHASE_APPLICANT_H_SETUP_PASSWORD -ErrorAction SilentlyContinue
  $purchaseAdminSecure = $null
  $applicantASecure = $null
  $applicantBSecure = $null
  $applicantCSecure = $null
  $applicantDSecure = $null
  $applicantESecure = $null
  $applicantHSecure = $null
}
