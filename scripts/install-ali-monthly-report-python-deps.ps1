param(
  [string]$Python = '',
  [string]$Wheelhouse = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-AppRoot {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (Test-Path (Join-Path $scriptDir 'tools')) {
    return $scriptDir
  }
  return (Split-Path -Parent $scriptDir)
}

function Test-PythonDependencies {
  param(
    [string]$Command,
    [string]$ProbePath
  )

  try {
    & $Command $ProbePath legacy *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$appRoot = Resolve-AppRoot
$dependencyProbePath = Join-Path $appRoot 'tools/ali-monthly-report/python_dependency_probe.py'
if (!(Test-Path -LiteralPath $dependencyProbePath -PathType Leaf)) {
  throw "Python dependency probe not found: $dependencyProbePath"
}
$pythonCommand = if ($Python.Trim()) {
  $Python.Trim()
} elseif ($env:ALI_MONTHLY_REPORT_PYTHON) {
  $env:ALI_MONTHLY_REPORT_PYTHON
} elseif ($env:PYTHON) {
  $env:PYTHON
} else {
  'python'
}

if (
  Test-PythonDependencies `
    -Command $pythonCommand `
    -ProbePath $dependencyProbePath
) {
  Write-Host '[OK] Ali monthly report Python dependencies are already ready.'
  exit 0
}

$requirements = @(
  (Join-Path $appRoot 'tools/ali-monthly-report/requirements.txt')
  (Join-Path $appRoot 'tools/ali-monthly-report-email/requirements.txt')
)

foreach ($requirementsPath in $requirements) {
  if (!(Test-Path $requirementsPath)) {
    throw "Requirements file not found: $requirementsPath"
  }
}

$wheelhousePath = if ($Wheelhouse.Trim()) {
  (Resolve-Path -LiteralPath $Wheelhouse.Trim()).Path
} else {
  $bundledWheelhouse = Join-Path $appRoot 'python/wheelhouse'
  if (Test-Path -LiteralPath $bundledWheelhouse -PathType Container) {
    (Resolve-Path -LiteralPath $bundledWheelhouse).Path
  } else {
    ''
  }
}

$pipArgs = @(
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '--no-input',
  '--only-binary=:all:',
  '--timeout', '120',
  '--retries', '5'
)

if ($wheelhousePath) {
  $wheels = @(Get-ChildItem -LiteralPath $wheelhousePath -File -Filter '*.whl')
  if ($wheels.Count -eq 0) {
    throw "No Python wheels found in wheelhouse: $wheelhousePath"
  }
  $pipArgs += @('--no-index', '--find-links', $wheelhousePath)
  Write-Host "[INFO] Installing Ali monthly report dependencies from offline wheelhouse: $wheelhousePath"
} else {
  Write-Host '[INFO] Offline wheelhouse not found; using the configured pip HTTPS index.'
}

foreach ($requirementsPath in $requirements) {
  $pipArgs += @('-r', $requirementsPath)
}

& $pythonCommand @pipArgs
if ($LASTEXITCODE -ne 0) {
  throw 'Ali monthly report Python dependency installation failed.'
}

if (!(
    Test-PythonDependencies `
      -Command $pythonCommand `
      -ProbePath $dependencyProbePath
  )) {
  throw 'Ali monthly report Python dependencies still fail import verification after installation.'
}

Write-Host '[OK] Ali monthly report Python dependencies are ready.'
