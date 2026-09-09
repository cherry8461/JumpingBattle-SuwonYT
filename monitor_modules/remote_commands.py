"""Safe command hand-off between the dashboard and JumpingBattleRemoteBridge."""

import hmac
import json
import os
import uuid
from datetime import datetime, timedelta

from flask import Blueprint, current_app, jsonify, request


ROOM_IDS = {"C1", "C2", "B1", "B2"}
# The established Hwasung bridge uses the manager's internal panel IDs,
# while this dashboard uses the staff-facing room labels.
AGENT_ROOM_TO_DASHBOARD = {"0": "C1", "1": "C2", "2": "B1", "3": "B2"}
DASHBOARD_ROOM_TO_AGENT = {room: agent for agent, room in AGENT_ROOM_TO_DASHBOARD.items()}

# Manager MQTT expects the map *serial*, not the position in an on-screen
# dropdown.  The Hwasung bridge deliberately keeps its room snapshots small,
# so resolve the serial locally instead of requiring a remote map list.
MAP_SERIALS = {
    "small:basic": 236, "small:easy": 233, "small:normal": 234,
    "small:hard": 237, "small:challenger": 254,
    "medium:basic": 231, "medium:easy": 215, "medium:normal": 209,
    "medium:hard": 214, "medium:challenger": 253,
    "large:basic": 221, "large:easy": 213, "large:normal": 210,
    "large:hard": 212, "large:challenger": 256,
    "small:space": 255, "small:summer": 262, "small:kids": 267, "small:santa": 270,
    "medium:space": 252, "medium:summer": 261, "medium:kids": 266, "medium:santa": 269,
    "large:space": 217, "large:summer": 250, "large:kids": 222, "large:santa": 265,
}

def _normalise_level_key(value):
    text = " ".join(str(value or "").split()).casefold()
    aliases = {
        "kids": ("kids", "\uc720\uc544", "\ud0a4\uc988"),
        "basic": ("basic", "\ubca0\uc774\uc9c1"),
        "easy": ("easy", "\uc774\uc9c0"),
        "normal": ("normal", "\ub178\uba40"),
        "hard": ("hard", "\ud558\ub4dc"),
        "challenger": ("challenger", "\ucc4c\ub9b0\uc800"),
        "space": ("space", "\uc6b0\uc8fc"),
        "summer": ("summer", "\uc5ec\ub984"),
        "santa": ("santa", "\uc0b0\ud0c0"),
    }
    return next((key for key, values in aliases.items() if any(item in text for item in values)), "")


def _normalise_map_size(value):
    text = str(value or "").replace(" ", "").casefold()
    if text in {"small", "\uc18c\ud615"}:
        return "small"
    if text in {"medium", "\uc911\ud615"}:
        return "medium"
    if text in {"large", "\ub300\ud615"}:
        return "large"
    return ""
LEVEL_ALIASES = {
    "유아": ("유아", "키즈", "kids"),
    "베이직": ("베이직", "basic"),
    "여름": ("여름", "summer"),
    "이지": ("이지", "easy"),
    "우주": ("우주", "space"),
    "노멀": ("노멀", "normal"),
    "산타": ("산타", "santa"),
    "하드": ("하드", "hard"),
    "챌린저": ("챌린저", "challenger"),
}


def _json(value, fallback):
    try:
        parsed = json.loads(value or "")
        return parsed if isinstance(parsed, type(fallback)) else fallback
    except (TypeError, ValueError):
        return fallback


def _normalise_level(value):
    text = " ".join(str(value or "").split())[:80]
    lowered = text.casefold()
    for canonical, aliases in LEVEL_ALIASES.items():
        if any(alias.casefold() in lowered for alias in aliases):
            return canonical
    return ""


def _map_index_for_level(map_options, level, map_prefix=""):
    """Find the manager's exact map entry, including small/medium/large mode."""
    aliases = LEVEL_ALIASES.get(level, ())
    expected_prefix = str(map_prefix or "").replace(" ", "").casefold()
    for index, option in enumerate(map_options or (), start=1):
        label = str(option or "").replace(" ", "").casefold()
        option_prefix = label.split("-", 1)[0]
        if (
            (not expected_prefix or option_prefix == expected_prefix)
            and any(alias.casefold() in label for alias in aliases)
        ):
            return index
    return None


def create_remote_commands_blueprint(socketio, get_connection):
    blueprint = Blueprint("remote_commands", __name__)

    def agent_authorized():
        expected = os.getenv("REMOTE_BRIDGE_AGENT_TOKEN", "")
        provided = request.headers.get("x-jumping-agent-token", "")
        return bool(expected and hmac.compare_digest(expected, provided))

    def record_event(cursor, command_id, room_id, event_type, actor_id="", detail=None):
        cursor.execute(
            """INSERT INTO command_history
               (command_id, room_id, event_type, actor_id, detail_json)
               VALUES (?, ?, ?, ?, ?)""",
            (command_id, room_id, event_type, actor_id, json.dumps(detail or {}, ensure_ascii=False)),
        )

    @blueprint.post("/api/agent/sync")
    def agent_sync():
        if not agent_authorized():
            return jsonify(success=False, message="Unauthorized agent"), 401

        body = request.get_json(silent=True) or {}
        agent_id = str(body.get("agentId") or "").strip()[:100]
        rooms = body.get("rooms")
        if not agent_id or not isinstance(rooms, list):
            return jsonify(success=False, message="Invalid agent sync payload"), 400

        # Keep a minimal diagnostic trace for bridge compatibility checks.
        # This deliberately records only the agent id and room identifiers,
        # never customer or credential data.
        current_app.logger.debug(
            "Remote agent sync: agent=%s rooms=%s",
            agent_id,
            [str(item.get("roomId") or "") for item in rooms if isinstance(item, dict)],
        )

        active_rooms = []
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn = get_connection()
        cursor = conn.cursor()
        try:
            for room in rooms:
                if not isinstance(room, dict):
                    continue
                source_room_id = str(room.get("roomId") or "").upper().strip()
                room_id = AGENT_ROOM_TO_DASHBOARD.get(source_room_id, source_room_id)
                if room_id not in ROOM_IDS:
                    continue
                active_rooms.append(room_id)
                state = {
                    "status": str(room.get("status") or "offline")[:30],
                    "teamName": str(room.get("teamName") or "")[:10],
                    "mapName": str(room.get("mapName") or "")[:120],
                    "mapIndex": room.get("mapIndex") or 0,
                    "mapOptions": room.get("mapOptions") if isinstance(room.get("mapOptions"), list) else [],
                    "uiBridge": bool(room.get("uiBridge")),
                    "level": str(room.get("level") or "")[:80],
                    "people": room.get("people") or 0,
                    "remainingSeconds": room.get("remainingSeconds") or 0,
                }
                cursor.execute(
                    """INSERT INTO room_agents
                       (agent_id, room_id, agent_name, agent_version, connection_mode, status,
                        last_seen_at, capabilities_json, updated_at)
                       VALUES (?, ?, ?, ?, 'mqtt', 'online', ?, ?, ?)
                       ON CONFLICT(agent_id) DO UPDATE SET
                         room_id=excluded.room_id, agent_name=excluded.agent_name,
                         agent_version=excluded.agent_version, status='online',
                         last_seen_at=excluded.last_seen_at,
                         capabilities_json=excluded.capabilities_json, updated_at=excluded.updated_at""",
                    (
                        f"{agent_id}:{room_id}", room_id, agent_id,
                        str(body.get("version") or "")[:50], now,
                        json.dumps(state, ensure_ascii=False), now,
                    ),
                )

            cursor.execute(
                """UPDATE command_queue SET status='expired', error_message='Command expired'
                   WHERE status IN ('pending', 'delivered')
                     AND expires_at IS NOT NULL AND expires_at < ?""",
                (now,),
            )

            commands = []
            if active_rooms:
                placeholders = ",".join("?" for _ in active_rooms)
                cursor.execute(
                    f"""SELECT command_id, room_id, command_type, payload_json
                        FROM command_queue
                       WHERE status='pending' AND room_id IN ({placeholders})
                       ORDER BY requested_at ASC LIMIT 20""",
                    active_rooms,
                )
                for row in cursor.fetchall():
                    payload = _json(row[3], {})
                    commands.append({
                        # Reply in the bridge's manager-panel ID convention.
                        "id": row[0], "roomId": DASHBOARD_ROOM_TO_AGENT.get(row[1], row[1]),
                        "action": row[2], "payload": payload,
                    })
                    cursor.execute(
                        """UPDATE command_queue SET status='delivered', claimed_by=?, claimed_at=?
                           WHERE command_id=? AND status='pending'""",
                        (agent_id, now, row[0]),
                    )
                    record_event(cursor, row[0], row[1], "delivered", agent_id)
            conn.commit()
        finally:
            conn.close()

        return jsonify(success=True, commands=commands)

    @blueprint.post("/api/agent/ack")
    def agent_ack():
        if not agent_authorized():
            return jsonify(success=False, message="Unauthorized agent"), 401
        body = request.get_json(silent=True) or {}
        command_id = str(body.get("commandId") or "").strip()[:100]
        status = str(body.get("status") or "").strip().lower()
        if not command_id or status not in {"executing", "completed", "failed"}:
            return jsonify(success=False, message="Invalid command acknowledgement"), 400

        result = body.get("result") if isinstance(body.get("result"), dict) else {"value": body.get("result")}
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT room_id FROM command_queue WHERE command_id=?", (command_id,))
            row = cursor.fetchone()
            if not row:
                return jsonify(success=False, message="Unknown command"), 404
            room_id = row[0]
            completed_at = now if status in {"completed", "failed"} else None
            error_message = str(result.get("error") or result.get("message") or "")[:500] if status == "failed" else ""
            cursor.execute(
                """UPDATE command_queue
                   SET status=?, completed_at=?, result_json=?, error_message=?
                   WHERE command_id=?""",
                (status, completed_at, json.dumps(result, ensure_ascii=False), error_message, command_id),
            )
            record_event(cursor, command_id, room_id, status, str(body.get("agentId") or "")[:100], result)
            conn.commit()
        finally:
            conn.close()
        socketio.emit("room_or_queue_changed")
        return jsonify(success=True)

    @blueprint.post("/api/game-commands/set-info")
    def request_set_info():
        body = request.get_json(silent=True) or {}
        room_id = str(body.get("roomId") or "").upper().strip()
        team_name = " ".join(str(body.get("teamName") or "").split())[:10]
        level = _normalise_level(body.get("level"))
        map_prefix = str(body.get("mapPrefix") or "").strip()[:10]
        expected_prefixes = {"C1": {"소형"}, "C2": {"소형"}, "B1": {"중형", "대형"}, "B2": {"중형", "대형"}}
        # Keep the legacy display validation below harmless, but use stable
        # ASCII keys for the actual manager map lookup.
        map_size = _normalise_map_size(body.get("mapPrefix"))
        level = _normalise_level_key(body.get("level"))
        allowed_sizes = {"C1": {"small"}, "C2": {"small"}, "B1": {"medium", "large"}, "B2": {"medium", "large"}}
        if room_id not in ROOM_IDS or not team_name or not level or map_size not in allowed_sizes.get(room_id, set()):
            return jsonify(success=False, message="방, 팀명, 난이도를 확인해주세요."), 400
        map_prefix = next(iter(expected_prefixes.get(room_id, set())), "")
        if room_id not in ROOM_IDS or not team_name or not level or map_prefix not in expected_prefixes.get(room_id, set()):
            return jsonify(success=False, message="방, 팀명, 난이도를 확인해주세요."), 400

        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(
                """SELECT capabilities_json, last_seen_at FROM room_agents
                   WHERE room_id=? AND status='online'
                   ORDER BY updated_at DESC LIMIT 1""",
                (room_id,),
            )
            agent = cursor.fetchone()
            if not agent:
                return jsonify(success=False, message=f"{room_id} 방 원격 브리지가 연결되지 않았습니다."), 409
            state = _json(agent[0], {})
            map_index = MAP_SERIALS.get(f"{map_size}:{level}")
            if map_index is None:
                return jsonify(success=False, message=f"{room_id} 방의 원격 맵 목록에서 '{level}' 난이도를 찾지 못했습니다."), 409

            command_id = uuid.uuid4().hex
            expires_at = (datetime.now() + timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")
            payload = {
                "teamName": team_name,
                "mapIndex": map_index or 0,
                "level": level,
                "levelKey": level,
                "mapPrefix": map_size,
                "skipPeople": True,
                "durationMinutes": 16,
            }
            cursor.execute(
                """INSERT INTO command_queue
                   (command_id, room_id, command_type, payload_json, status, requested_by, expires_at)
                   VALUES (?, ?, 'set_info', ?, 'pending', 'dashboard', ?)""",
                (command_id, room_id, json.dumps(payload, ensure_ascii=False), expires_at),
            )
            record_event(cursor, command_id, room_id, "requested", "dashboard", {
                "teamName": team_name, "level": level, "mapIndex": map_index,
            })
            conn.commit()
        finally:
            conn.close()
        socketio.emit("room_or_queue_changed")
        return jsonify(success=True, commandId=command_id, message=f"{room_id} 방 게임 프로그램으로 전송 요청했습니다.")

    @blueprint.post("/api/game-commands/start-game")
    def request_start_game():
        body = request.get_json(silent=True) or {}
        room_id = str(body.get("roomId") or "").upper().strip()
        if room_id not in ROOM_IDS:
            return jsonify(success=False, message="방 정보를 확인해주세요."), 400

        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(
                """SELECT capabilities_json, last_seen_at FROM room_agents
                   WHERE room_id=? AND status='online'
                   ORDER BY updated_at DESC LIMIT 1""",
                (room_id,),
            )
            agent = cursor.fetchone()
            if not agent:
                return jsonify(success=False, message=f"{room_id} 방 브리지가 연결되지 않았습니다."), 409
            try:
                last_seen = datetime.strptime(str(agent[1]), "%Y-%m-%d %H:%M:%S")
            except (TypeError, ValueError):
                last_seen = datetime.min
            if datetime.now() - last_seen > timedelta(seconds=5):
                return jsonify(success=False, message=f"{room_id} 방 브리지 연결이 끊겼습니다."), 409
            state = _json(agent[0], {})
            game_status = str(state.get("status") or "").strip()
            if "게임중" in game_status or game_status.casefold() in {"playing", "running", "in_game"}:
                return jsonify(
                    success=False,
                    code="game_already_running",
                    message=f"{room_id} 방은 이미 게임이 진행 중입니다.",
                ), 409

            command_id = uuid.uuid4().hex
            expires_at = (datetime.now() + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute(
                """INSERT INTO command_queue
                   (command_id, room_id, command_type, payload_json, status, requested_by, expires_at)
                   VALUES (?, ?, 'start_game', '{}', 'pending', 'dashboard', ?)""",
                (command_id, room_id, expires_at),
            )
            record_event(cursor, command_id, room_id, "requested", "dashboard", {"action": "start_game"})
            conn.commit()
        finally:
            conn.close()
        socketio.emit("room_or_queue_changed")
        return jsonify(success=True, commandId=command_id, message=f"{room_id} 방 게임 시작을 요청했습니다.")

    @blueprint.post("/api/game-commands/stop-game")
    def request_stop_game():
        body = request.get_json(silent=True) or {}
        room_id = str(body.get("roomId") or "").upper().strip()
        if room_id not in ROOM_IDS:
            return jsonify(success=False, message="방 정보를 확인해주세요."), 400

        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(
                """SELECT last_seen_at FROM room_agents
                   WHERE room_id=? AND status='online'
                   ORDER BY updated_at DESC LIMIT 1""",
                (room_id,),
            )
            agent = cursor.fetchone()
            if not agent:
                return jsonify(success=False, message=f"{room_id} 방 브릿지가 연결되지 않았습니다."), 409
            try:
                last_seen = datetime.strptime(str(agent[0]), "%Y-%m-%d %H:%M:%S")
            except (TypeError, ValueError):
                last_seen = datetime.min
            if datetime.now() - last_seen > timedelta(seconds=5):
                return jsonify(success=False, message=f"{room_id} 방 브릿지 연결이 끊겼습니다."), 409

            command_id = uuid.uuid4().hex
            expires_at = (datetime.now() + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute(
                """INSERT INTO command_queue
                   (command_id, room_id, command_type, payload_json, status, requested_by, expires_at)
                   VALUES (?, ?, 'stop_game', '{}', 'pending', 'dashboard', ?)""",
                (command_id, room_id, expires_at),
            )
            record_event(cursor, command_id, room_id, "requested", "dashboard", {"action": "stop_game"})
            conn.commit()
        finally:
            conn.close()
        socketio.emit("room_or_queue_changed")
        return jsonify(success=True, commandId=command_id, message=f"{room_id} 방 게임 정지를 요청했습니다.")

    return blueprint
