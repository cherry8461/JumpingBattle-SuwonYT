# JumpingBattle 수원영통

점핑배틀 수원영통 지점의 매장 운영 웹 소스입니다. 현재 운영 중인 Flask 기반 시스템을 Git으로 관리하고, 이후 클라우드 예약 시스템으로 단계적으로 이전하기 위한 기준 저장소입니다.

## 현재 기능

- 게임 관리자 프로그램 로그 기반 랭킹 표시
- 현장 접수와 대기열 관리
- 예약 관리와 엑셀 내보내기
- 일별 정산 및 비품 판매 내역 관리
- Google Sheets 연동
- Gmail 기반 네이버 예약 동기화 (기존 방식)

## 폴더 역할

| 위치 | 용도 |
| --- | --- |
| `D:\JumpingBattle_SuwonYT` | Git으로 관리하는 개발 기준 소스 |
| `D:\game_monitor` | 현재 매장에서 실행 중인 운영 프로그램과 운영 DB |
| `D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager` | 점핑배틀 관리자 프로그램과 게임 로그 |

새 기능은 이 저장소에서 먼저 개발하고 검토한 뒤, 충분히 확인한 후에만 운영 폴더에 반영합니다.

## 실행 준비

1. Python 3.13을 설치합니다.
2. 가상환경을 만들고 의존성을 설치합니다.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

3. `.env.example`을 복사해 `.env`를 만들고, 실제 값을 입력합니다.

```text
FLASK_SECRET_KEY=long-random-secret
GMAIL_USER=store-email@example.com
GMAIL_APP_PASSWORD=google-app-password
```

4. Google Sheets 연동을 사용할 경우, 운영 PC에만 `config/google_key.json`을 별도로 준비합니다. 이 파일은 Git에 올리지 않습니다.

## 운영 데이터와 보안

다음 파일은 고객 정보, 운영 정보 또는 인증 정보를 포함할 수 있으므로 GitHub에 올리지 않습니다.

- `.env`
- `config/google_key.json`, `config/credentials.json`
- `game_data.db`와 모든 DB 백업
- `logs/`, `*.log`
- `data.xlsx`, `*.zip`

운영 DB는 Git이 아니라 운영 PC와 별도 외부 백업 저장소에 보관합니다.

## 개발 원칙

- 기능 하나가 완료되고 확인될 때마다 커밋합니다.
- 운영 DB나 인증 파일을 커밋 목록에서 발견하면 즉시 제외합니다.
- 외부 공개 기능은 인증과 HTTPS를 적용한 클라우드 환경으로 단계적으로 이전합니다.
- 매장 PC는 장기적으로 게임 로그·MQTT 제어 브리지 역할로 한정합니다.

## 다음 이전 목표

1. Cloudflare 기반 외부 예약 웹과 클라우드 DB 구축
2. 네이버 예약 API 수집 및 재고 차단 기능 추가
3. 매장 PC 원격제어 브리지와 안전한 명령 대기열 연결
4. 기존 Gmail 예약 파싱 기능을 새 동기화 방식으로 교체

## Cloudflare 웹 템플릿

`cloudflare-web/`에는 Cloudflare Workers와 D1을 사용하는 새 예약·관리자 웹 템플릿이 있습니다. 이 폴더는 `cloudflare-reservation-platform` 브랜치에서 개발합니다.

수원영통 지점의 실제 방 순서, 맵 번호, 가격, 네이버 상품 ID, Cloudflare 프로젝트 ID는 운영 장비 및 계정 확인 후 설정합니다. 인증 토큰, PIN, 세션 비밀값, 운영 DB는 저장소에 넣지 않습니다.
