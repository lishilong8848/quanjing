[CmdletBinding()]
param(
  [string]$PayloadPath = (Join-Path $PSScriptRoot 'repair-ali-monthly-report-python-runtime.ps1'),
  [string]$PortablePythonArchivePath = '',
  [string]$Pywin32RepairArchivePath = '',
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'

function Convert-ToChunkedBase64 {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [int]$LineLength = 4096
  )

  $base64 = [Convert]::ToBase64String($Bytes)
  $lines = New-Object System.Collections.Generic.List[string]
  for ($offset = 0; $offset -lt $base64.Length; $offset += $LineLength) {
    $length = [Math]::Min($LineLength, $base64.Length - $offset)
    $lines.Add($base64.Substring($offset, $length))
  }
  return ($lines -join "`r`n")
}

$resolvedPayload = [System.IO.Path]::GetFullPath($PayloadPath)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $resolvedPayload -PathType Leaf)) {
  throw "PowerShell payload was not found: $resolvedPayload"
}
if ([System.IO.Path]::GetExtension($resolvedOutput) -ne '.cmd') {
  throw 'OutputPath must use the .cmd extension.'
}

$portablePythonSha256 = ''
$portablePythonBase64 = ''
if (-not [string]::IsNullOrWhiteSpace($PortablePythonArchivePath)) {
  $resolvedPortablePythonArchive = [System.IO.Path]::GetFullPath($PortablePythonArchivePath)
  if (-not (Test-Path -LiteralPath $resolvedPortablePythonArchive -PathType Leaf)) {
    throw "Portable Python archive was not found: $resolvedPortablePythonArchive"
  }
  $portablePythonSha256 = (Get-FileHash -LiteralPath $resolvedPortablePythonArchive -Algorithm SHA256).Hash
  $portablePythonBase64 = Convert-ToChunkedBase64 -Bytes ([System.IO.File]::ReadAllBytes($resolvedPortablePythonArchive))
}

$pywin32RepairSha256 = ''
$pywin32RepairBase64 = ''
if (-not [string]::IsNullOrWhiteSpace($Pywin32RepairArchivePath)) {
  $resolvedPywin32RepairArchive = [System.IO.Path]::GetFullPath($Pywin32RepairArchivePath)
  if (-not (Test-Path -LiteralPath $resolvedPywin32RepairArchive -PathType Leaf)) {
    throw "Pywin32 repair archive was not found: $resolvedPywin32RepairArchive"
  }
  $pywin32RepairSha256 = (Get-FileHash -LiteralPath $resolvedPywin32RepairArchive -Algorithm SHA256).Hash
  $pywin32RepairBase64 = Convert-ToChunkedBase64 -Bytes ([System.IO.File]::ReadAllBytes($resolvedPywin32RepairArchive))
}

$outputParent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}

$launcher = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Ali Monthly Report Python Runtime Repair
set "ALI_REPAIR_SELF=%~f0"
set "ALI_REPAIR_TEMP=%TEMP%\ali-monthly-report-repair-%RANDOM%-%RANDOM%.ps1"
set "ALI_REPAIR_EXIT=1"
set "ALI_REPAIR_PYTHON_SHA256=__PORTABLE_PYTHON_SHA256__"
set "ALI_REPAIR_PYWIN32_SHA256=__PYWIN32_REPAIR_SHA256__"

echo [INFO] Starting Ali monthly report repair...
echo [INFO] Extracting embedded repair program...
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$reader=[IO.File]::OpenText($env:ALI_REPAIR_SELF); $encoding=New-Object Text.UTF8Encoding($false); $writer=[IO.StreamWriter]::new($env:ALI_REPAIR_TEMP,$false,$encoding); $copy=$false; $done=$false; try { while(($line=$reader.ReadLine()) -ne $null) { if($line -eq '@@POWERSHELL_PAYLOAD@@') { $copy=$true; continue }; if($copy -and $line -eq '@@PORTABLE_PYTHON_ZIP_BASE64@@') { $done=$true; break }; if($copy) { $writer.WriteLine($line) } } } finally { $writer.Dispose(); $reader.Dispose() }; if(-not $copy -or -not $done) { exit 2 }"
if errorlevel 1 (
  echo [ERROR] Failed to prepare the embedded repair program.
  goto :finish
)
echo [INFO] Embedded repair program ready.

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%ALI_REPAIR_TEMP%" -AppRoot "%~dp0." __PORTABLE_PYTHON_ARGUMENT__
set "ALI_REPAIR_EXIT=%ERRORLEVEL%"

:finish
if exist "%ALI_REPAIR_TEMP%" del /f /q "%ALI_REPAIR_TEMP%" >nul 2>&1
echo.
if "%ALI_REPAIR_EXIT%"=="0" (
  echo [OK] Repair completed. Refresh the browser and retry sending the email.
) else (
  echo [ERROR] Repair failed. Keep this window open and take a screenshot of the error above.
)
echo Press any key to close this window...
pause >nul
exit /b %ALI_REPAIR_EXIT%
@@POWERSHELL_PAYLOAD@@
'@

$payload = [System.IO.File]::ReadAllText($resolvedPayload)
$launcher = $launcher.Replace('__PORTABLE_PYTHON_SHA256__', $portablePythonSha256)
$launcher = $launcher.Replace('__PYWIN32_REPAIR_SHA256__', $pywin32RepairSha256)
$portablePythonArgument = if ([string]::IsNullOrWhiteSpace($portablePythonSha256)) { '' } else { '-ForcePortablePython' }
$launcher = $launcher.Replace('__PORTABLE_PYTHON_ARGUMENT__', $portablePythonArgument)
$normalizedLauncher = ($launcher.TrimEnd() -replace "`r?`n", "`r`n")
$normalizedPayload = ($payload.TrimStart([char[]]"`r`n") -replace "`r?`n", "`r`n")
$normalizedBase64 = ($portablePythonBase64 -replace "`r?`n", "`r`n")
$normalizedPywin32Base64 = ($pywin32RepairBase64 -replace "`r?`n", "`r`n")
$content = $normalizedLauncher + "`r`n" + $normalizedPayload.TrimEnd([char[]]"`r`n") + "`r`n@@PORTABLE_PYTHON_ZIP_BASE64@@`r`n" + $normalizedBase64.TrimEnd([char[]]"`r`n") + "`r`n@@PYWIN32_REPAIR_ZIP_BASE64@@`r`n" + $normalizedPywin32Base64
if (-not $content.EndsWith("`r`n")) {
  $content += "`r`n"
}
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutput, $content, $encoding)

Write-Output ('CMD_READY=' + $resolvedOutput)
