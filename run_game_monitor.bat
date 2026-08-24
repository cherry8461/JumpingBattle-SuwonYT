@echo off
REM -------------------------------
REM Python Flask 로그 모니터 실행 (UTF-8)
REM -------------------------------

REM 콘솔 코드페이지 UTF-8로 변경
chcp 65001

REM Python 경로 지정 (설치 위치에 맞게 변경)
set PYTHON_PATH=C:\Users\Jumping\AppData\Local\Programs\Python\Python313\python.exe

REM app.py 경로 지정
set APP_PATH=D:\game_monitor\app.py

REM 서버 실행
"%PYTHON_PATH%" "%APP_PATH%"

pause