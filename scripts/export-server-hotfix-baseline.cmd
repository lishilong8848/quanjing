@echo off
setlocal
set "TOOL_DIR=%~dp0"
set "APP_ROOT="
if exist "%TOOL_DIR%package.json" set "APP_ROOT=%TOOL_DIR%."
if not defined APP_ROOT if exist "%TOOL_DIR%..\package.json" set "APP_ROOT=%TOOL_DIR%.."

if defined APP_ROOT (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%export-server-hotfix-baseline.ps1" -AppRoot "%APP_ROOT%"
) else (
  echo Auto-detecting the current Nantong server application directory...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%export-server-hotfix-baseline.ps1"
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Baseline export finished. Send the generated ZIP and SHA256 file back to Codex.
) else (
  echo Baseline export failed. No application service was changed.
)
pause
exit /b %EXIT_CODE%
