@echo off
setlocal
cd /d "%~dp0backend"
call npx tsx scripts\narrate-from-file.ts
echo.
pause
endlocal
