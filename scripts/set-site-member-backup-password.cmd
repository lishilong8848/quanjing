@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-site-member-backup-password.ps1" %*
set RESULT=%ERRORLEVEL%
pause
exit /b %RESULT%
