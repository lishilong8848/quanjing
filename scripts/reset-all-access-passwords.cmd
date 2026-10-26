@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-all-access-passwords.ps1" -EnvFile "%~dp0..\.env"
if errorlevel 1 (
  echo Password reset failed. Review the message above before restarting the application.
) else (
  echo Password reset completed. Restart the application to apply it.
)
pause
