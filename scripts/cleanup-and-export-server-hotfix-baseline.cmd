@echo off
setlocal
set "TOOL_DIR=%~dp0"
set "APP_ROOT="
if exist "%TOOL_DIR%package.json" set "APP_ROOT=%TOOL_DIR%."
if not defined APP_ROOT if exist "%TOOL_DIR%..\package.json" set "APP_ROOT=%TOOL_DIR%.."

echo This will quarantine unreferenced client chunks and export a fresh baseline.
if defined APP_ROOT (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%export-server-hotfix-baseline.ps1" -AppRoot "%APP_ROOT%" -PruneHistoricalClientChunks
) else (
  echo Auto-detecting the current Nantong server application directory...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%export-server-hotfix-baseline.ps1" -PruneHistoricalClientChunks
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Cleanup and fresh baseline export finished.
  echo Send the generated ZIP and SHA256 file back to Codex.
) else (
  echo Cleanup or baseline export failed. Review the error above.
)
pause
exit /b %EXIT_CODE%
