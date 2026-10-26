@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-today-operations-alarm-ai.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Alarm AI configuration failed; review the message above.
pause
exit /b %RESULT%
