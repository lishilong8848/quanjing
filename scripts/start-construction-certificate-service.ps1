param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 58000,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$serviceRoot = Join-Path $repoRoot 'tools/construction-certificate-service'
if (!(Test-Path $serviceRoot)) {
  throw "Construction certificate service not found: $serviceRoot"
}

$python = $env:CONSTRUCTION_CERTIFICATE_SERVICE_PYTHON
if (!$python) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (!$pythonCommand) {
    throw 'Python was not found. Set CONSTRUCTION_CERTIFICATE_SERVICE_PYTHON to python.exe.'
  }
  $python = $pythonCommand.Source
}

function Test-CertificateServiceDependencies {
  param([string]$PythonPath)

  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $PythonPath -W ignore -c "import fastapi, uvicorn, selenium, ddddocr, PIL, lark_oapi" *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
}

if (!$SkipInstall -and $env:CONSTRUCTION_CERTIFICATE_SERVICE_SKIP_INSTALL -ne 'true') {
  if (!(Test-CertificateServiceDependencies -PythonPath $python)) {
    & $python -m pip install -r (Join-Path $serviceRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
      throw 'Failed to install construction certificate service Python dependencies.'
    }
  }
}

if (!(Test-CertificateServiceDependencies -PythonPath $python)) {
  throw 'Construction certificate service Python dependencies are missing.'
}

$env:HOST = $HostName
$env:PORT = [string]$Port

Set-Location $serviceRoot
& $python -m app.server
