@echo off
chcp 65001
title SuwonYT Bridge
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0suwonyt-direct-ui-bridge.ps1"
pause
