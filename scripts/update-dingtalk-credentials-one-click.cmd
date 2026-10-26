@echo off
setlocal
chcp 65001 >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ONE-CLICK-HOTFIX.ps1" -AppRoot "%~dp0." -UpdateDingTalkCredentials
set "HOTFIX_EXIT=%ERRORLEVEL%"

if not "%HOTFIX_EXIT%"=="0" (
  echo.
  echo [FAILED] Runtime update was not completed. If credential validation succeeded above, those credentials remain saved.
  pause
  exit /b %HOTFIX_EXIT%
)

echo.
echo [OK] Credentials, update, startup health check, and DingTalk preflight passed.
pause
exit /b 0
