"""Reservation availability rules for the Suwon Yeongtong customer service.

The calendar source is deliberately separated from the schedule calculation so
an official Korean holiday feed can be added without changing booking rules.
Until then, the caller supplies any staff-configured date override.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta


WEEKDAY = "weekday"
WEEKEND_OR_HOLIDAY = "weekend_or_holiday"


def day_type(target_date: date, staff_override: str | None = None, is_public_holiday: bool = False) -> str:
    """Return the operating-day type, giving staff exceptions highest priority."""
    if staff_override in {WEEKDAY, WEEKEND_OR_HOLIDAY}:
        return staff_override
    if target_date.weekday() >= 5 or is_public_holiday:
        return WEEKEND_OR_HOLIDAY
    return WEEKDAY


def standard_room_slots(target_date: date, *, staff_override: str | None = None, is_public_holiday: bool = False) -> list[str]:
    """Return 20-minute, one-game reservation starts for C1/C2/B1/B2."""
    kind = day_type(target_date, staff_override, is_public_holiday)
    opening_hour = 12 if kind == WEEKDAY else 10
    return _time_range(time(opening_hour, 0), time(23, 0), 20)


def party_room_slots(target_date: date, *, staff_override: str | None = None, is_public_holiday: bool = False) -> list[dict[str, str | int]]:
    """Return party-room starts with 120-minute use and 30-minute turnaround."""
    kind = day_type(target_date, staff_override, is_public_holiday)
    starts = ["12:00", "14:30", "17:00", "19:30"] if kind == WEEKDAY else ["11:00", "19:00"]
    return [
        {
            "start_time": start,
            "end_time": _add_minutes(start, 120),
            "turnaround_end_time": _add_minutes(start, 150),
            "use_minutes": 120,
            "reservation_block_minutes": 150,
        }
        for start in starts
    ]


def _time_range(start: time, end: time, step_minutes: int) -> list[str]:
    cursor = datetime.combine(date.min, start)
    cutoff = datetime.combine(date.min, end)
    slots: list[str] = []
    while cursor < cutoff:
        slots.append(cursor.strftime("%H:%M"))
        cursor += timedelta(minutes=step_minutes)
    return slots


def _add_minutes(start: str, minutes: int) -> str:
    parsed = datetime.strptime(start, "%H:%M")
    return (parsed + timedelta(minutes=minutes)).strftime("%H:%M")
