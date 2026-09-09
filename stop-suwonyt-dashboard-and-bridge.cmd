@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-suwonyt-dashboard-and-bridge.ps1"
pause
