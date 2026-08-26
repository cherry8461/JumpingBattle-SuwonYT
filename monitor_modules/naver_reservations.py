"""Authenticated intake for Naver Booking Chrome extension data."""

from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime

from flask import Blueprint, jsonify, request

from monitor_core.database import get_db_connection


ROOM_PATTERN = re.compile(r"\b(C1|C2|B1|B2)\b", re.IGNORECASE)
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
                if normalized["is_cancelled"]:
                    if handling_mode != "onsite_payment":
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
                    if handling_mode == "onsite_payment":
                        accepted += 1
                        continue
                    cursor.execute(
                        """
                        INSERT INTO naver_mail_cache
                            (booking_id, masked_name, use_date, use_time_key, room_name, status)
                        VALUES (?, ?, ?, ?, ?, 'INIT')
                        ON CONFLICT(booking_id) DO UPDATE SET
                            masked_name=excluded.masked_name,
                            use_date=excluded.use_date,
                            use_time_key=excluded.use_time_key,
                            room_name=excluded.room_name,
                            status=CASE
                                WHEN naver_mail_cache.status='CONFIRMED' THEN 'CONFIRMED'
                                ELSE 'INIT'
                            END
                        """,
                        (
                            normalized["booking_id"],
                            normalized["customer_name"],
                            normalized["use_date"],
                            normalized["use_time_key"],
                            normalized["room_name"],
                        ),
                    )
                accepted += 1

        socketio.emit(
            "naver_reservations_synced",
            {"accepted": accepted, "ignored": ignored, "same_day_cancellations": same_day_cancellations},
        )
        return jsonify(
            success=True,
            accepted=accepted,
            ignored=ignored,
            same_day_cancellations=same_day_cancellations,
        )

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
