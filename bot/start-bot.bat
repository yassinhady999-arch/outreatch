@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Mersal bot %1
:loop
node --env-file=.env index.mjs %1
echo.
echo Bot stopped - starting again in 15 seconds. Close this window to stop it.
timeout /t 15 /nobreak >nul
goto loop
