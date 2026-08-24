# 수원영통 운영본 구조

## 실행 흐름

`run_game_monitor.bat` → `app.py` → `monitor_core/settings.py` → 로컬 SQLite DB 및 매니저 로그

- `.env`: PC별 비밀값과 경로. GitHub에 올리지 않는다.
- `monitor_core/settings.py`: 경로·포트 같은 공통 설정.
- `monitor_core/database.py`: SQLite 연결 공통 옵션.
- `app.py`: 현재 운영 기능과 HTTP API. 기존 동작 보존을 위해 단계적으로 기능 모듈로 옮긴다.

## 화면 파일

- `templates/dashboard.html`: 운영 대시보드 화면 구조.
- `static/css/dashboard.css`: 대시보드 전용 스타일.
- `static/js/dashboard.js`: 예약·대기열·결제·정산 등 기존 대시보드 동작.
- `templates/settlement.html`, `team_list.html`, `walkin.html`: 독립 화면.

## 이후 분리 순서

1. `app.py`의 API를 예약·대기열·정산·워크인·게임상태 단위로 나눈다.
2. `dashboard.js`를 예약표·대기열·결제·정산·방상태 단위로 나눈다.
3. 네이버 확장 수신과 MQTT 명령은 새 모듈로 추가한다. 기존 화면 코드에 직접 섞지 않는다.

## 운영 원칙

- DB 스키마 변경은 추가 방식으로 진행하고, 기존 데이터 삭제는 별도 백업과 승인 후에만 한다.
- 새 외부 연동의 토큰·비밀번호·사업장 식별값은 `.env` 또는 Cloudflare Secret에만 둔다.
- 이전 복사본 파일은 Git 이력으로 복구할 수 있으므로 현재 배포 파일에는 남기지 않는다.
