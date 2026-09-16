@echo off
setlocal
chcp 65001
title SuwonYT Dashboard and Ranking
set "GAME_MONITOR_DB_PATH=D:\game_monitor\game_data.db"
set "GAME_MONITOR_LOG_DIR=D:\JumpingBattle_SuwonYT\logs"
set "GAME_MANAGER_LOG_DIR=D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager\file\log"
set "GAME_MONITOR_HOST=0.0.0.0"
set "GAME_MONITOR_PORT=8080"
cd /d "%~dp0"
"C:\Users\jumping\AppData\Local\Programs\Python\Python313\python.exe" "%~dp0app.py"
pause
