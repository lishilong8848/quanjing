@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-feishu-card-callback-profile.ps1"
set "CONFIG_EXIT=%ERRORLEVEL%"

if not "%CONFIG_EXIT%"=="0" (
  echo.
  echo [FAILED] Configuration was not completed. Existing settings were preserved.
  echo.
  pause
  exit /b %CONFIG_EXIT%
)

echo.
pause
exit /b 0
