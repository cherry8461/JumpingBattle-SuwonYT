# 게임카드 원격 전송 설정

대시보드 게임카드의 파란 위쪽 버튼은 팀명과 난이도에 맞는 맵을 해당 방의
점핑배틀 관리자 프로그램으로 전송합니다. 게임 시작·정지 명령은 포함하지
않습니다.

## 1. 신규본 `.env`

`.env.example`의 아래 값을 복사해 실제 긴 임의 문자열로 바꿉니다.

```env
REMOTE_BRIDGE_AGENT_TOKEN=별도의_긴_임의_문자열
```

이 값은 네이버 확장 토큰과 다르게 설정하고, GitHub에 올리지 않습니다.

## 2. 원격 브리지 설정

`JumpingBattleRemoteBridge` 폴더의 `bridge-config.json`에서 아래 값만 매장에
맞게 설정합니다.

```json
{
  "server_url": "http://127.0.0.1:8081",
  "agent_token": "REMOTE_BRIDGE_AGENT_TOKEN과_동일한_값",
  "agent_id": "suwonyt-main",
  "poll_seconds": 0.5,
  "armed": false,
  "simulate": false,
  "manager_dir": "D:\\JPLuncher\\apps\\250625_v2_0_3_JumPing_Manager"
}
```

대시보드와 브리지가 서로 다른 PC에 있다면 `server_url`에는 대시보드 PC의
HTTPS 주소를 넣습니다. MQTT 포트(1883)는 공유기에 개방하지 않습니다.

## 3. 처음 시험하는 순서

1. 점핑배틀 관리자 프로그램을 실행합니다.
2. 브리지의 `diagnose-bridge.cmd`를 실행해 안전 확인을 합니다.
3. 브리지를 먼저 안전 잠금 상태(`armed: false`)로 실행합니다.
4. 대시보드에서 빈 방 카드에 팀명과 난이도를 입력하고 파란 위쪽 버튼을 누릅니다.
   브리지가 연결되어 있으면 해당 방의 팀명과 맵이 전송됩니다.
5. 실제 전송이 맞는 것을 확인한 뒤에만 `enable-live-control.cmd`로 원격 제어를
   허용합니다.

맵 목록에 해당 난이도가 없거나 브리지가 연결되지 않은 경우, 대시보드는 명령을
보내지 않고 이유를 표시합니다.
