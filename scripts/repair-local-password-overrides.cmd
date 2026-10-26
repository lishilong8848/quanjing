@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-local-password-overrides.ps1" -AppRoot "%~dp0.."
if errorlevel 1 (
  echo Repair failed. Review the message above. Do not restart until the configuration is checked.
)
pause
