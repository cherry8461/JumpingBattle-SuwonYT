"""Read-only customer reservation availability for the self-booking page."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, render_template, request

from monitor_core.database import get_db_connection
from .holiday_calendar import operating_day_type
from .reservation_schedule import party_room_slots, standard_room_slots


STANDARD_ROOMS = ("C1", "C2", "B1", "B2")
PARTY_ROOMS = {
    "small": ("PARTY_SMALL", "소형"),
    "medium": ("PARTY_MEDIUM", "중형"),
    "large": ("PARTY_LARGE", "대형"),
}
MAX_BOOKING_LOOKAHEAD_DAYS = 90


def create_customer_reservations_blueprint() -> Blueprint:
    blueprint = Blueprint("customer_reservations", __name__)

    @blueprint.get("/reserve")
    def reserve_page():
        return render_template("reserve.html")

    @blueprint.get("/my-reservations")
    def my_reservations_page():
        """Safe entry point for customer reservation lookup and cancellation."""
        return render_template("my_reservations.html")

    @blueprint.get("/api/public-reservations/availability")
    def availability():
        target_date = _parse_target_date(request.args.get("date"))
        product = request.args.get("product", "standard_room")
        if not target_date:
            return jsonify(success=False, message="오늘부터 90일 이내의 날짜를 선택하세요."), 400
        if product == "standard_room":
            return jsonify(success=True, **_standard_availability(target_date))
        if product == "party_room":
            room_size = request.args.get("room_size", "small")
            if room_size not in PARTY_ROOMS:
                return jsonify(success=False, message="파티룸 크기를 확인하세요."), 400
            return jsonify(success=True, **_party_availability(target_date, room_size))
        return jsonify(success=False, message="예약 상품을 확인하세요."), 400

    return blueprint


def _standard_availability(target_date: date) -> dict:
    resolved_day_type, calendar_source = operating_day_type(target_date)
    slot_times = standard_room_slots(target_date, staff_override=resolved_day_type)
    blocked = _blocked_slots(target_date, STANDARD_ROOMS)
    rooms = []
    for room_id in STANDARD_ROOMS:
        rooms.append(
            {
                "room_id": room_id,
                "display_name": room_id,
                "slots": [{"start_time": value, "available": (room_id, value) not in blocked} for value in slot_times],
            }
        )
    return {
        "date": target_date.isoformat(),
        "product": "standard_room",
        "day_type": resolved_day_type,
        "calendar_source": calendar_source,
        "rooms": rooms,
    }


def _party_availability(target_date: date, room_size: str) -> dict:
    resolved_day_type, calendar_source = operating_day_type(target_date)
    room_id, display_name = PARTY_ROOMS[room_size]
    blocked = _blocked_slots(target_date, (room_id,))
    slots = party_room_slots(target_date, staff_override=resolved_day_type)
    return {
        "date": target_date.isoformat(),
        "product": "party_room",
        "day_type": resolved_day_type,
        "calendar_source": calendar_source,
        "room": {"room_id": room_id, "display_name": display_name},
        "slots": [
            {**slot, "available": (room_id, slot["start_time"]) not in blocked}
            for slot in slots
        ],
    }


def _blocked_slots(target_date: date, room_ids: tuple[str, ...]) -> set[tuple[str, str]]:
    placeholders = ",".join("?" for _ in room_ids)
    now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    connection = get_db_connection()
    try:
        rows = connection.execute(
            f"""
            SELECT room_id, time_key
              FROM reservation_slots
             WHERE slot_date=?
               AND room_id IN ({placeholders})
               AND (slot_status='confirmed' OR (slot_status='hold' AND expires_at>?))
            """,
            (target_date.isoformat(), *room_ids, now_text),
        ).fetchall()
        blocked = {(str(room_id), str(time_key)) for room_id, time_key in rows}
        if set(room_ids).issubset(set(STANDARD_ROOMS)):
            legacy_rows = connection.execute(
                f"""
                SELECT room, time_key FROM bookings
                 WHERE booking_date=? AND room IN ({placeholders})
                """,
                (target_date.isoformat(), *room_ids),
            ).fetchall()
            blocked.update((str(room).upper(), _normalise_legacy_time(str(time_key))) for room, time_key in legacy_rows)
            naver_rows = connection.execute(
                f"""
                SELECT room_name, use_time_key FROM naver_reservations
                 WHERE use_date=? AND room_name IN ({placeholders})
                   AND booking_status IN ('CONFIRMED', 'COMPLETED')
                """,
                (target_date.isoformat(), *room_ids),
            ).fetchall()
            blocked.update((str(room).upper(), _normalise_legacy_time(str(time_key))) for room, time_key in naver_rows)
        return blocked
    finally:
        connection.close()


def _normalise_legacy_time(value: str) -> str:
    if ":" in value:
        hour, minute = value.split(":", 1)
    elif "-" in value:
        hour, minute = value.split("-", 1)
    else:
        return value
    try:
        return f"{int(hour):02d}:{int(minute):02d}"
    except ValueError:
        return value


def _parse_target_date(value: str | None) -> date | None:
    try:
        target = date.fromisoformat(str(value or ""))
    except ValueError:
        return None
    today = date.today()
    return target if today <= target <= today + timedelta(days=MAX_BOOKING_LOOKAHEAD_DAYS) else None
