@echo off
REM -------------------------------
REM Python Flask 로그 모니터 실행 (UTF-8)
REM -------------------------------

REM 콘솔 코드페이지 UTF-8로 변경
chcp 65001

REM Python 경로 지정 (설치 위치에 맞게 변경)
set PYTHON_PATH=C:\Users\Jumping\AppData\Local\Programs\Python\Python313\python.exe

REM app.py 경로 지정
set APP_PATH=D:\JumpingBattle_SuwonYT\app.py
set GAME_MONITOR_DB_PATH=D:\JumpingBattle_SuwonYT\data\game_data.db
set GAME_MONITOR_LOG_DIR=D:\JumpingBattle_SuwonYT\logs
set GAME_MANAGER_LOG_DIR=D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager\file\log
set GAME_MONITOR_HOST=127.0.0.1
set GAME_MONITOR_PORT=8081

REM 서버 실행
"%PYTHON_PATH%" "%APP_PATH%"

pause
