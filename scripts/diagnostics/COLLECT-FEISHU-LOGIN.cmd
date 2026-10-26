@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Collect-FeishuLogin.ps1"
set "DIAG_EXIT=%ERRORLEVEL%"
echo.
if "%DIAG_EXIT%"=="0" echo Send the feishu-login-diagnostics JSON beside this tool. No service or account changes were made.
if not "%DIAG_EXIT%"=="0" echo Collection failed. Do not stop the service, change accounts or remove locks.
pause
exit /b %DIAG_EXIT%
