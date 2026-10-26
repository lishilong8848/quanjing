param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  $powerShell = (Get-Process -Id $PID).Path
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ('"' + $PSCommandPath + '"'), '-Root', ('"' + $Root + '"')
  )
  try {
    $elevated = Start-Process -FilePath $powerShell -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
  } catch {
    Write-Host '[FAILED] Administrator elevation was cancelled; no configuration was changed.' -ForegroundColor Red
    exit 1
  }
}

$appRoot = [System.IO.Path]::GetFullPath($Root)
$scriptPath = Join-Path $appRoot 'scripts/configure-today-operations-alarm-ai.mjs'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw 'Alarm AI configuration helper is missing; no configuration was changed.'
}

$node = Join-Path $appRoot '.runtime/node/node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $command) { throw 'Node.js was not found; no configuration was changed.' }
  $node = $command.Source
}
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
  throw 'Node.js 24 or newer is required; no configuration was changed.'
}

$secureKey = Read-Host 'Enter alarm AI API Key (input hidden)' -AsSecureString
if (-not $secureKey -or $secureKey.Length -eq 0) {
  throw 'No API Key was entered; no configuration was changed.'
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $node
$startInfo.Arguments = '"' + $scriptPath + '"'
$startInfo.WorkingDirectory = $appRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw 'Could not launch the configuration helper; no configuration was changed.'
}

$pointer = [IntPtr]::Zero
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $characterCount = [Runtime.InteropServices.Marshal]::ReadInt32($pointer, -4) / 2
  for ($index = 0; $index -lt $characterCount; $index++) {
    $character = [char][Runtime.InteropServices.Marshal]::ReadInt16($pointer, $index * 2)
    $process.StandardInput.Write($character)
  }
  $process.StandardInput.WriteLine()
  $process.StandardInput.Close()
} finally {
  if ($pointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  $secureKey.Dispose()
}

while (($line = $process.StandardOutput.ReadLine()) -ne $null) {
  Write-Host $line
}
$errorOutput = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
  if ($errorOutput) {
    Write-Host $errorOutput.Trim() -ForegroundColor Red
  }
  if ($errorOutput -match '\[FAILED\]') {
    Write-Host '[FAILED] AI setup did not complete. The helper attempted to restore the previous configuration and service.' -ForegroundColor Red
  } else {
    Write-Host '[FAILED] AI setup exited unexpectedly. Check service health before retrying.' -ForegroundColor Red
  }
  exit $process.ExitCode
}
Write-Host '[OK] Alarm AI key setup finished; read the online status above.' -ForegroundColor Green
