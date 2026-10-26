@echo off
setlocal
chcp 65001 >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ONE-CLICK-HOTFIX.ps1" -AppRoot "%~dp0."
set "HOTFIX_EXIT=%ERRORLEVEL%"

if not "%HOTFIX_EXIT%"=="0" (
  echo.
  echo [FAILED] Update was not completed. Read the error above; do not copy runtime files manually.
  pause
  exit /b %HOTFIX_EXIT%
)

echo.
echo [OK] Update, startup health check, and DingTalk preflight passed.
pause
exit /b 0
