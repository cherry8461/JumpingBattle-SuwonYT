# 네이버 예약 Chrome 확장 연결

## 서버 설정

새 운영본의 `.env`에 다음 값을 추가합니다.

```env
NAVER_AGENT_TOKEN=32자_이상의_무작위_비밀문자열
```

이 값은 GitHub에 올리지 않습니다.

## 확장 설정

화성점 확장의 `sw.js`에서 아래 두 설정만 수원영통 값으로 바꿉니다.

```js
const JUMPING_SITE_IMPORT_URL = "https://운영도메인/api/integrations/naver/reservations";
const JUMPING_SITE_IMPORT_TOKEN = "NAVER_AGENT_TOKEN과_같은_값";
```

예약 수신 주소는 `POST /api/integrations/naver/reservations`이며,
`x-jumping-agent-token` 헤더가 일치할 때만 처리합니다.

## 처리 방식

1. 확장은 네이버 파트너 예약을 읽어 서버로 전송합니다.
2. 서버는 `naver_reservations`에 예약 상태 이력을 저장합니다.
3. 확정/완료 예약만 기존 대시보드의 오늘 예약 확인 목록에 표시합니다.
4. 취소 예약은 대시보드 목록에서 숨기지만 DB에는 취소 상태를 남깁니다.

전화번호·예약 링크·원문 응답은 새 운영 DB에 저장하지 않습니다.
