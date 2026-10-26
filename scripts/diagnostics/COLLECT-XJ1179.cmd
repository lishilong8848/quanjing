@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Collect-XJ1179.ps1"
set "DIAG_EXIT=%ERRORLEVEL%"
echo.
if "%DIAG_EXIT%"=="0" echo Collection finished. Send the XJ1179-diagnostics-*.json file beside this tool.
if "%DIAG_EXIT%"=="2" echo Evidence incomplete. Send the generated JSON; do not re-approve the request.
if "%DIAG_EXIT%"=="1" echo Collection refused or failed. Send the error code; do not stop or restart the service.
pause
exit /b %DIAG_EXIT%
