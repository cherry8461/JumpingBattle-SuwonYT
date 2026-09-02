@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0suwonyt-ui-bridge-v2.ps1"
pause
