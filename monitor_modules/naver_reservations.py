"""Authenticated intake for Naver Booking Chrome extension data."""

from __future__ import annotations

import hmac
import json
import os
import re
import threading
from datetime import datetime

from flask import Blueprint, jsonify, request

from monitor_core.database import get_db_connection


_stock_event_condition = threading.Condition()
_stock_event_revision = 0


def notify_stock_plan_changed() -> None:
    """Wake the local Chrome extension when dashboard cards change."""
    global _stock_event_revision
    with _stock_event_condition:
        _stock_event_revision += 1
        _stock_event_condition.notify_all()


ROOM_PATTERN = re.compile(r"\b(C1|C2|B1|B2)\b", re.IGNORECASE)


def normalize_time_key(value: object) -> str:
    """Convert dashboard and Naver time formats to HH-MM."""
    parts = re.findall(r"\d+", str(value or ""))
    if len(parts) < 2:
        return ""
    hour, minute = (int(parts[0]), int(parts[1]))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return ""
    return f"{hour:02d}-{minute:02d}"


def record_dashboard_time_change(cursor, booking_row_id: int, booking_date: object, time_key: object, room: object) -> None:
    """Persist a phone-requested time change for a Naver-originated card.

    Same-time room reassignment is deliberately ignored: the original Naver
    reservation already owns one interchangeable physical room. Only a time
    change creates a stock compensation rule.
    """
    cursor.execute(
        """
        SELECT link.booking_id, link.card_state,
               reservation.use_date, reservation.use_time_key, reservation.room_name,
               reservation.cancelled_at
          FROM naver_booking_card_links AS link
          LEFT JOIN naver_reservations AS reservation ON reservation.booking_id=link.booking_id
         WHERE link.booking_row_id=?
        """,
        (booking_row_id,),
    )
    linked = cursor.fetchone()
    if not linked or not linked[0] or linked[1] == "cancelled_hidden" or linked[5]:
        return
    original_date = str(linked[2] or "")
    original_time = normalize_time_key(linked[3])
    original_room_match = ROOM_PATTERN.search(str(linked[4] or ""))
    operational_date = str(booking_date or "")
    operational_time = normalize_time_key(time_key)
    operational_room_match = ROOM_PATTERN.search(str(room or ""))
    if not (original_date and original_time and original_room_match and operational_date and operational_time and operational_room_match):
        return
    booking_id = str(linked[0])
    # Physical room reassignment within the same time does not affect Naver.
    if original_date == operational_date and original_time == operational_time:
        cursor.execute("DELETE FROM naver_time_overrides WHERE booking_id=?", (booking_id,))
        return
    cursor.execute(
        """
        INSERT INTO naver_time_overrides (
            booking_id, booking_row_id,
            source_date, source_time_key, source_room,
            operation_date, operation_time_key, operation_room,
            state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
        ON CONFLICT(booking_id) DO UPDATE SET
            booking_row_id=excluded.booking_row_id,
            source_date=excluded.source_date,
            source_time_key=excluded.source_time_key,
            source_room=excluded.source_room,
            operation_date=excluded.operation_date,
            operation_time_key=excluded.operation_time_key,
            operation_room=excluded.operation_room,
            state='active',
            updated_at=CURRENT_TIMESTAMP
        """,
        (
            booking_id, booking_row_id,
            original_date, original_time, original_room_match.group(1).upper(),
            operational_date, operational_time, operational_room_match.group(1).upper(),
        ),
    )


def clear_dashboard_time_change(cursor, booking_row_id: int) -> None:
    """Remove a stock compensation rule when its dashboard card is deleted."""
    cursor.execute("DELETE FROM naver_time_overrides WHERE booking_row_id=?", (booking_row_id,))


def ensure_naver_dashboard_card(cursor, normalized: dict) -> tuple[int | None, bool]:
    """Create one timetable card for an actionable Naver game-room booking.

    The old waiting-list confirmation flow is retained for non-game products,
    while C1/C2/B1/B2 reservations are placed on the timetable immediately.
    """
    room = str(normalized.get("room_name") or "").upper()
    if room not in {"C1", "C2", "B1", "B2"}:
        return None, False
    booking_id = str(normalized["booking_id"])
    cursor.execute(
        "SELECT booking_row_id FROM naver_booking_card_links WHERE booking_id=?",
        (booking_id,),
    )
    existing = cursor.fetchone()
    if existing and existing[0]:
        cursor.execute(
            "UPDATE naver_booking_card_links SET card_state='active', updated_at=CURRENT_TIMESTAMP WHERE booking_id=?",
            (booking_id,),
        )
        return int(existing[0]), False

    cursor.execute(
        "SELECT COALESCE(MAX(order_no), 0) FROM bookings WHERE booking_date=? AND time_key=? AND room=?",
        (normalized["use_date"], normalized["use_time_key"], room),
    )
    order_no = int(cursor.fetchone()[0] or 0) + 1
    payment_data = json.dumps(
        {
            "totalPeople": "",
            "roomFlags": {"F": False, "S": room.startswith("C"), "M": room.startswith("B"), "L": False},
            "roomFlagLabel": "소" if room.startswith("C") else "중",
            "isBooker": True,
            "depositPaid": True,
            "depositAmount": 5000,
            "reservationTime": normalized["use_time_key"].replace("-", ":"),
            "naverBookingId": booking_id,
        },
        ensure_ascii=False,
    )
    cursor.execute(
        """
        INSERT INTO bookings (
            booking_date, time_key, room, name, phone, team, level, people,
            order_no, paid, completed, payment_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 0, 0, ?)
        """,
        (
            normalized["use_date"], normalized["use_time_key"], room,
            normalized.get("customer_name", ""), normalized.get("phone", ""),
            str(normalized.get("team_name", ""))[:10], normalized.get("difficulty", ""),
            order_no, payment_data,
        ),
    )
    booking_row_id = int(cursor.lastrowid)
    cursor.execute(
        """
        INSERT INTO naver_booking_card_links (booking_id, booking_row_id, handling_mode, card_state)
        VALUES (?, ?, 'standard', 'active')
        ON CONFLICT(booking_id) DO UPDATE SET
            booking_row_id=excluded.booking_row_id,
            card_state='active',
            updated_at=CURRENT_TIMESTAMP
        """,
        (booking_id, booking_row_id),
    )
    return booking_row_id, True
DATE_PATTERN = re.compile(r"(20\d{2})[./-](\d{1,2})[./-](\d{1,2})")
TIME_PATTERN = re.compile(r"(?:오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})", re.IGNORECASE)


def create_naver_reservations_blueprint(socketio) -> Blueprint:
    blueprint = Blueprint("naver_reservations", __name__)

    @blueprint.post("/api/integrations/naver/reservations")
    def receive_reservations():
        expected_token = os.getenv("NAVER_AGENT_TOKEN", "")
        provided_token = request.headers.get("x-jumping-agent-token", "")
        if not expected_token or not hmac.compare_digest(provided_token, expected_token):
            return jsonify(success=False, message="Unauthorized agent"), 401

        body = request.get_json(silent=True)
        items = body.get("items") if isinstance(body, dict) else None
        if not isinstance(items, list) or not items:
            return jsonify(success=False, message="items must be a non-empty list"), 400
        if len(items) > 300:
            return jsonify(success=False, message="too many items"), 413

        accepted = 0
        ignored = 0
        same_day_cancellations = 0
        cards_created = 0
        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with get_db_connection() as connection:
            cursor = connection.cursor()
            for item in items:
                normalized = normalize_item(item)
                if not normalized:
                    ignored += 1
                    continue

                cursor.execute(
                    """
                    INSERT INTO naver_reservations (
                        booking_id, booking_status, use_date, use_time_key, room_name,
                        product_name, customer_name, team_name, difficulty, phone,
                        people_count, booking_fingerprint,
                        first_seen_at, updated_at, cancelled_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(booking_id) DO UPDATE SET
                        booking_status=excluded.booking_status,
                        use_date=excluded.use_date,
                        use_time_key=excluded.use_time_key,
                        room_name=excluded.room_name,
                        product_name=excluded.product_name,
                        customer_name=excluded.customer_name,
                        team_name=excluded.team_name,
                        difficulty=excluded.difficulty,
                        phone=excluded.phone,
                        people_count=excluded.people_count,
                        booking_fingerprint=excluded.booking_fingerprint,
                        updated_at=excluded.updated_at,
                        cancelled_at=excluded.cancelled_at
                    """,
                    (*normalized["record"], now_text, now_text, normalized["cancelled_at"]),
                )

                handling_mode, dashboard_booking_id = get_card_link(cursor, normalized["booking_id"])
                # A staff member uses the existing reservation-deposit checkbox.
                # Only its explicit saved marker can keep a cancelled card visible.
                keep_card_for_onsite_payment = (
                    handling_mode == "onsite_payment"
                    or is_linked_card_marked_for_onsite_payment(cursor, dashboard_booking_id)
                )
                if normalized["is_cancelled"]:
                    # A customer cancellation ends any phone-requested time
                    # change. The extension will release its moved-to slot.
                    cursor.execute("DELETE FROM naver_time_overrides WHERE booking_id=?", (normalized["booking_id"],))
                    if not keep_card_for_onsite_payment:
                        if register_cancellation(cursor, normalized["booking_id"], normalized["use_date"]):
                            same_day_cancellations += 1
                        if dashboard_booking_id:
                            cursor.execute(
                                "UPDATE naver_booking_card_links SET card_state='cancelled_hidden', updated_at=CURRENT_TIMESTAMP WHERE booking_id=?",
                                (normalized["booking_id"],),
                            )
                    cursor.execute("DELETE FROM naver_mail_cache WHERE booking_id=?", (normalized["booking_id"],))
                elif normalized["is_actionable"]:
                    restore_reversed_cancellation(cursor, normalized["booking_id"], normalized["use_date"])
                    if keep_card_for_onsite_payment:
                        accepted += 1
                        continue
                    _, created = ensure_naver_dashboard_card(cursor, normalized)
                    cards_created += int(created)
                    # Game-room reservations are now placed immediately on
                    # the timetable, so they must not wait in the walk-in box.
                    # Non-game products retain the existing manual workflow.
                    cache_status = 'CONFIRMED' if normalized["room_name"] in {"C1", "C2", "B1", "B2"} else 'INIT'
                    cursor.execute(
                        """
                        INSERT INTO naver_mail_cache
                            (booking_id, masked_name, use_date, use_time_key, room_name, status)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(booking_id) DO UPDATE SET
                            masked_name=excluded.masked_name,
                            use_date=excluded.use_date,
                            use_time_key=excluded.use_time_key,
                            room_name=excluded.room_name,
                            status=excluded.status
                        """,
                        (
                            normalized["booking_id"],
                            normalized["customer_name"],
                            normalized["use_date"],
                            normalized["use_time_key"],
                            normalized["room_name"],
                            cache_status,
                        ),
                    )
                accepted += 1

        socketio.emit(
            "naver_reservations_synced",
            {"accepted": accepted, "ignored": ignored, "same_day_cancellations": same_day_cancellations, "cards_created": cards_created},
        )
        # A new Naver booking can change a source-slot compensation from 1 to
        # 2 (or more), so wake the stock reconciliation immediately.
        notify_stock_plan_changed()
        return jsonify(
            success=True,
            accepted=accepted,
            ignored=ignored,
            same_day_cancellations=same_day_cancellations,
            cards_created=cards_created,
        )

    @blueprint.get("/api/integrations/naver/stock-plan")
    def get_stock_plan():
        """Return local cards that must close Naver availability.

        Naver-originated cards stay excluded. Staff may move such a card
        between equivalent physical rooms on the dashboard, while Naver keeps
        owning its original reservation slot. The Chrome extension is the
        sole writer for locally created cards.
        """
        expected_token = os.getenv("NAVER_AGENT_TOKEN", "")
        provided_token = request.headers.get("x-jumping-agent-token", "")
        if not expected_token or not hmac.compare_digest(provided_token, expected_token):
            return jsonify(success=False, message="Unauthorized agent"), 401

        today = datetime.now().strftime("%Y-%m-%d")
        with get_db_connection() as connection:
            rows = connection.execute(
                """
                SELECT booking_date, time_key, room
                  FROM bookings AS booking
                  LEFT JOIN naver_booking_card_links AS link ON link.booking_row_id=booking.id
                 WHERE booking_date >= ?
                   AND booking_date <= date(?, '+14 days')
                   AND COALESCE(booking.completed, 0)=0
                   AND UPPER(TRIM(booking.room)) IN ('C1', 'C2', 'B1', 'B2')
                   AND link.booking_id IS NULL
                 GROUP BY booking_date, time_key, room
                 ORDER BY booking_date, time_key, room
                """,
                (today, today),
            ).fetchall()
        slots = []
        for row in rows:
            if not (row[0] and row[1] and row[2]):
                continue
            time_parts = re.findall(r"\d+", str(row[1]))
            if len(time_parts) < 2:
                continue
            hour, minute = (int(time_parts[0]), int(time_parts[1]))
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                continue
            slots.append({
                "room": row[2],
                "date": row[0],
                "time": f"{hour:02d}:{minute:02d}",
                "stock": 0,
                "kind": "local_card",
            })
        # Time changes made by phone leave the original Naver reservation in
        # place. For each source slot, increase Naver's stock enough to offset
        # only the reservations that are now operated at another time.
        with get_db_connection() as connection:
            override_rows = connection.execute(
                """
                SELECT override.booking_id,
                       override.source_date, override.source_time_key, override.source_room,
                       override.operation_date, override.operation_time_key, override.operation_room
                  FROM naver_time_overrides AS override
                  JOIN naver_reservations AS source ON source.booking_id=override.booking_id
                 WHERE override.state='active'
                   AND source.cancelled_at IS NULL
                   AND override.source_date >= ?
                   AND override.source_date <= date(?, '+14 days')
                """,
                (today, today),
            ).fetchall()
            source_groups: dict[tuple[str, str, str], list[object]] = {}
            for override in override_rows:
                source_key = (str(override[1]), str(override[2]), str(override[3]).upper())
                source_groups.setdefault(source_key, []).append(override)
                operation_time = normalize_time_key(override[5])
                operation_room_match = ROOM_PATTERN.search(str(override[6] or ""))
                if operation_time and operation_room_match:
                    slots.append({
                        "room": operation_room_match.group(1).upper(),
                        "date": str(override[4]),
                        "time": operation_time.replace("-", ":"),
                        "stock": 0,
                        "kind": "time_change_target",
                    })
            adjustments = []
            for (source_date, source_time, source_room), grouped_overrides in source_groups.items():
                active_count = connection.execute(
                    """
                    SELECT COUNT(*)
                      FROM naver_reservations
                     WHERE use_date=?
                       AND use_time_key=?
                       AND UPPER(room_name)=?
                       AND cancelled_at IS NULL
                       AND booking_status <> 'CANCELED'
                    """,
                    (source_date, source_time, source_room),
                ).fetchone()[0]
                # Example: original A is moved (1 active, 1 moved) -> stock 1.
                # A plus new B at the old time (2 active, 1 moved) -> stock 2.
                adjusted_stock = max(1, int(active_count) - len(grouped_overrides) + 1)
                adjustments.append({
                    "room": source_room,
                    "date": source_date,
                    "time": source_time.replace("-", ":"),
                    "stock": adjusted_stock,
                    "kind": "time_change_source",
                    "movedBookingCount": len(grouped_overrides),
                    "activeBookingCount": int(active_count),
                })
        return jsonify(success=True, slots=slots, adjustments=adjustments)

    @blueprint.get("/api/integrations/naver/stock-events")
    def wait_for_stock_event():
        expected_token = os.getenv("NAVER_AGENT_TOKEN", "")
        provided_token = request.headers.get("x-jumping-agent-token", "")
        if not expected_token or not hmac.compare_digest(provided_token, expected_token):
            return jsonify(success=False, message="Unauthorized agent"), 401
        try:
            after = max(int(request.args.get("after", "0")), 0)
        except ValueError:
            after = 0
        with _stock_event_condition:
            if _stock_event_revision <= after:
                _stock_event_condition.wait(timeout=20)
            return jsonify(success=True, revision=_stock_event_revision, changed=_stock_event_revision > after)

    return blueprint


def get_card_link(cursor, booking_id: str) -> tuple[str, int | None]:
    cursor.execute(
        "SELECT handling_mode, booking_row_id FROM naver_booking_card_links WHERE booking_id=?",
        (booking_id,),
    )
    row = cursor.fetchone()
    if not row:
        return "standard", None
    return str(row[0] or "standard"), int(row[1]) if row[1] else None


def is_linked_card_marked_for_onsite_payment(cursor, dashboard_booking_id: int | None) -> bool:
    """Read the explicit marker written when staff uncheck a Naver deposit."""
    if not dashboard_booking_id:
        return False
    cursor.execute("SELECT payment_data FROM bookings WHERE id=?", (dashboard_booking_id,))
    row = cursor.fetchone()
    if not row:
        return False
    try:
        payment_data = json.loads(row[0] or "{}")
    except (TypeError, json.JSONDecodeError):
        return False
    return payment_data.get("naverDepositCancelledByStaff") is True


def normalize_item(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    booking_id = str(item.get("bookNo") or item.get("bookingId") or "").strip()
    if not booking_id or len(booking_id) > 100:
        return None

    use_date, use_time_key = parse_when(item.get("when"))
    if not use_date:
        return None
    product_name = clean_text(item.get("product"), 200)
    room_match = ROOM_PATTERN.search(product_name)
    room_name = room_match.group(1).upper() if room_match else ""
    customer_name = clean_text(item.get("name"), 80)
    team_name = clean_text(item.get("teamName"), 120)
    difficulty = normalize_difficulty(item.get("difficulty"))
    phone = normalize_phone(item.get("phone"))
    status = normalize_status(item.get("status"))
    # Naver's booking count defaults to 1 even when the group size has not
    # been decided.  Do not copy that placeholder into the operation board.
    people_count = 0
    fingerprint = json.dumps(
        {
            "status": status,
            "when": f"{use_date} {use_time_key}",
            "room": room_name,
            "product": product_name,
            "name": customer_name,
            "team": team_name,
            "difficulty": difficulty,
            "people": people_count,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    is_cancelled = status == "CANCELED"
    return {
        "booking_id": booking_id,
        "use_date": use_date,
        "use_time_key": use_time_key,
        "room_name": room_name,
        "customer_name": customer_name,
        "team_name": team_name,
        "difficulty": difficulty,
        "phone": phone,
        "people_count": people_count,
        "is_cancelled": is_cancelled,
        "is_actionable": status in {"CONFIRMED", "COMPLETED"},
        "cancelled_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S") if is_cancelled else None,
        "record": (
            booking_id,
            status,
            use_date,
            use_time_key,
            room_name,
            product_name,
            customer_name,
            team_name,
            difficulty,
            phone,
            people_count,
            fingerprint,
        ),
    }


def register_cancellation(cursor, booking_id: str, use_date: str) -> bool:
    """Count a same-day cancellation once, even if the extension retries delivery."""
    cursor.execute(
        "INSERT OR IGNORE INTO naver_cancellation_events (booking_id, use_date) VALUES (?, ?)",
        (booking_id, use_date),
    )
    is_first_cancellation = cursor.rowcount == 1
    is_today = use_date == datetime.now().strftime("%Y-%m-%d")
    if not (is_first_cancellation and is_today):
        return False
    cursor.execute(
        """
        INSERT INTO settlement_daily_meta (target_date, no_show_count, updated_at)
        VALUES (?, 1, datetime('now', 'localtime'))
        ON CONFLICT(target_date) DO UPDATE SET
            no_show_count=settlement_daily_meta.no_show_count + 1,
            updated_at=datetime('now', 'localtime')
        """,
        (use_date,),
    )
    return True


def restore_reversed_cancellation(cursor, booking_id: str, use_date: str) -> None:
    """Undo a same-day count if a reservation later returns to an active state."""
    cursor.execute("DELETE FROM naver_cancellation_events WHERE booking_id=?", (booking_id,))
    removed_event = cursor.rowcount == 1
    if not (removed_event and use_date == datetime.now().strftime("%Y-%m-%d")):
        return
    cursor.execute(
        """
        UPDATE settlement_daily_meta
           SET no_show_count=MAX(no_show_count - 1, 0),
               updated_at=datetime('now', 'localtime')
         WHERE target_date=?
        """,
        (use_date,),
    )


def parse_when(value: object) -> tuple[str, str]:
    text = str(value or "")
    date_match = DATE_PATTERN.search(text)
    time_match = TIME_PATTERN.search(text)
    if not date_match or not time_match:
        return "", ""
    year, month, day = (int(part) for part in date_match.groups())
    hour, minute = (int(part) for part in time_match.groups())
    if re.search(r"오후|PM", text, re.IGNORECASE) and hour != 12:
        hour += 12
    if re.search(r"오전|AM", text, re.IGNORECASE) and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return "", ""
    try:
        use_date = datetime(year, month, day).strftime("%Y-%m-%d")
    except ValueError:
        return "", ""
    return use_date, f"{hour:02d}-{minute:02d}"


def normalize_status(value: object) -> str:
    text = str(value or "").upper()
    if "취소" in str(value or "") or "CANCEL" in text or "REFUND" in text:
        return "CANCELED"
    if "완료" in str(value or "") or "COMPLETE" in text or "USED" in text:
        return "COMPLETED"
    return "CONFIRMED"


def normalize_difficulty(value: object) -> str:
    """Convert Naver's full form answer to the dashboard's short level label."""
    difficulty = clean_text(value, 200)
    if not difficulty:
        return ""

    labels = (
        ("basic", "\ubca0\uc774\uc9c1"),
        ("easy", "\uc774\uc9c0"),
        ("normal", "\ub178\uba40"),
        ("hard", "\ud558\ub4dc"),
        ("challenger", "\ucc4c\ub9b0\uc800"),
        ("kids", "\uc720\uc544"),
        ("toddler", "\uc720\uc544"),
        ("summer", "\uc5ec\ub984"),
        ("space", "\uc6b0\uc8fc"),
        ("santa", "\uc0b0\ud0c0"),
    )
    lower_value = difficulty.casefold()
    for keyword, label in labels:
        if keyword in lower_value:
            return label

    # Keep a manually entered Korean dashboard label as it is.
    return difficulty[:80]


def clean_text(value: object, max_length: int) -> str:
    return " ".join(str(value or "").split())[:max_length]


def safe_people_count(value: object) -> int | None:
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    return count if 0 < count <= 30 else None


def normalize_phone(value: object) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits if 8 <= len(digits) <= 15 else ""
