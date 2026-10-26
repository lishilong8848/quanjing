param(
  [string]$Python = '',
  [string]$ReadyFile = '',
  [string]$PidFile = ''
)

$ErrorActionPreference = 'Stop'
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$requirementsPath = Join-Path $scriptRoot 'requirements-contract-preview.txt'
$pythonCommand = if ($Python.Trim()) {
  $Python.Trim()
} elseif ($env:PYTHON_EXECUTABLE) {
  $env:PYTHON_EXECUTABLE
} else {
  'python'
}
$readyFilePath = if ($ReadyFile.Trim()) { $ReadyFile.Trim() } else { $env:CONTRACT_PREVIEW_READY_FILE }
$pidFilePath = if ($PidFile.Trim()) { $PidFile.Trim() } else { $env:CONTRACT_PREVIEW_INSTALL_PID_FILE }
$ownerToken = $env:CONTRACT_PREVIEW_INSTALL_OWNER_TOKEN

if (!(Test-Path -LiteralPath $requirementsPath)) {
  throw "Requirements file not found: $requirementsPath"
}

try {
  if ($readyFilePath) {
    Remove-Item -LiteralPath $readyFilePath -Force -ErrorAction SilentlyContinue
  }

  & $pythonCommand -m pip install --disable-pip-version-check --no-input --only-binary=:all: --timeout 30 --retries 2 -r $requirementsPath
  if ($LASTEXITCODE -ne 0) {
    throw 'Contract preview dependency installation failed.'
  }

  & $pythonCommand -c "import fitz; from PIL import Image"
  if ($LASTEXITCODE -ne 0) {
    throw 'Contract preview dependency verification failed.'
  }

  if ($readyFilePath) {
    $readyDirectory = Split-Path -Parent $readyFilePath
    if ($readyDirectory) {
      New-Item -ItemType Directory -Force -Path $readyDirectory | Out-Null
    }
    Set-Content -LiteralPath $readyFilePath -Value ((Get-Date).ToString('s')) -Encoding ASCII
  }

  Write-Host '[OK] Contract preview Python dependencies are installed and importable.' -ForegroundColor Green
} finally {
  if ($pidFilePath -and $ownerToken -and (Test-Path -LiteralPath $pidFilePath)) {
    $pidRecord = $null
    try {
      $pidRecord = Get-Content -Raw -LiteralPath $pidFilePath -ErrorAction Stop | ConvertFrom-Json
    } catch {
      $pidRecord = $null
    }
    if (
      $pidRecord -and
      [string]$pidRecord.ownerToken -eq [string]$ownerToken -and
      [string]$pidRecord.pid -eq [string]$PID
    ) {
      Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
    }
  }
}
