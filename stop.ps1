param()

$ErrorActionPreference = 'Stop'

function Resolve-AppRoot {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (Test-Path (Join-Path $scriptDir 'dist/server/main.js')) {
    return $scriptDir
  }
  return (Split-Path -Parent $scriptDir)
}

function Get-DotEnvValue {
  param(
    [string]$FilePath,
    [string]$Name,
    [string]$DefaultValue = ''
  )

  if (!(Test-Path $FilePath)) {
    return $DefaultValue
  }

  $line = Get-Content -LiteralPath $FilePath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1

  if (!$line) {
    return $DefaultValue
  }

  return ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", '').Trim().Trim('"').Trim("'")
}

function Stop-PidFileProcess {
  param(
    [string]$PidFile,
    [string]$Label
  )

  if (!(Test-Path $PidFile)) {
    return $false
  }

  $stopped = $false
  $pidValue = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pidValue) {
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Write-Host "[OK] Stopped $Label by PID: $($process.Id)" -ForegroundColor Green
      $stopped = $true
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  return $stopped
}

function Stop-ListeningProcessesOnPort {
  param([int]$Port)

  if ($Port -le 0) {
    return $false
  }

  $stopped = $false
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (!$process) {
      continue
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Stopped process listening on port $Port`: $($process.ProcessName) PID $($process.Id)" -ForegroundColor Green
    $stopped = $true
  }
  return $stopped
}

function Stop-AllScheduleNodeProcesses {
  $stopped = $false
  $currentPid = $PID
  $processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -and
      ($_.CommandLine -match 'dist[\\/]+server[\\/]+main\.js' -or $_.CommandLine -match 'dist/server/main\.js')
    }

  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Stopped schedule Node process PID $($process.ProcessId)" -ForegroundColor Green
    $stopped = $true
  }

  return $stopped
}

$appRoot = Resolve-AppRoot
$resolvedRoot = (Resolve-Path $appRoot).Path
$envFile = Join-Path $appRoot '.env'
$configuredPort = [int](Get-DotEnvValue -FilePath $envFile -Name 'SERVER_PORT' -DefaultValue '3001')
$pidFile = Join-Path $appRoot 'app.pid'
$browserPidFile = Join-Path $appRoot 'browser.pid'
$browserProfile = Join-Path $appRoot 'browser-profile'

$stoppedApp = Stop-PidFileProcess -PidFile $pidFile -Label 'app'
$stoppedAllSchedule = Stop-AllScheduleNodeProcesses
$stoppedByPort = Stop-ListeningProcessesOnPort -Port $configuredPort
$stoppedApp = $stoppedApp -or $stoppedAllSchedule -or $stoppedByPort

if (!$stoppedApp) {
  $candidates = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.Contains('dist/server/main') -and
      $_.CommandLine.Contains($resolvedRoot)
    }

  foreach ($candidate in $candidates) {
    Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Stopped app process: $($candidate.ProcessId)" -ForegroundColor Green
    $stoppedApp = $true
  }
}

$stoppedBrowser = Stop-PidFileProcess -PidFile $browserPidFile -Label 'browser'

if (Test-Path $browserProfile) {
  $browserProcesses = Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and $_.CommandLine.Contains($browserProfile)
    }

  foreach ($browserProcess in $browserProcesses) {
    Stop-Process -Id $browserProcess.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Closed browser window: $($browserProcess.ProcessId)" -ForegroundColor Green
    $stoppedBrowser = $true
  }
}

if (!$stoppedApp) {
  Write-Host '[INFO] App service is not running.' -ForegroundColor Yellow
}
if (!$stoppedBrowser) {
  Write-Host '[INFO] Managed browser window is not running.' -ForegroundColor Yellow
}
