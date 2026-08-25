"""Low-traffic Korean public-holiday lookup shared by reservation availability."""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

from monitor_core.database import get_db_connection
from .reservation_schedule import WEEKDAY, WEEKEND_OR_HOLIDAY, day_type


NAGER_DATE_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/KR"
RETRY_DELAY = timedelta(hours=6)


def operating_day_type(target_date: date, fetcher=None) -> tuple[str, str]:
    """Resolve a day type with staff override, yearly cache, then weekend fallback.

    Returns ``(day_type, source)``. A source of ``weekend_fallback`` means the
    holiday provider was unavailable and staff should review any weekday date.
    """
    override = _get_staff_override(target_date)
    if override:
        return day_type(target_date, staff_override=override), "staff_override"
    is_holiday, source = is_korean_public_holiday(target_date, fetcher=fetcher)
    return day_type(target_date, is_public_holiday=is_holiday), source


def is_korean_public_holiday(target_date: date, fetcher=None) -> tuple[bool, str]:
    dates, source = _dates_for_year(target_date.year, fetcher=fetcher)
    return target_date.isoformat() in dates, source


def _get_staff_override(target_date: date) -> str | None:
    connection = get_db_connection()
    try:
        row = connection.execute(
            "SELECT day_type FROM day_type_overrides WHERE target_date=?",
            (target_date.isoformat(),),
        ).fetchone()
    finally:
        connection.close()
    if not row:
        return None
    return WEEKDAY if row[0] == "weekday" else WEEKEND_OR_HOLIDAY if row[0] == "weekend" else None


def _dates_for_year(year: int, fetcher=None) -> tuple[set[str], str]:
    connection = get_db_connection()
    try:
        row = connection.execute(
            """
            SELECT dates_json, last_attempt_at, last_success_at, last_error
              FROM reservation_holiday_calendar_years
             WHERE calendar_year=?
            """,
            (year,),
        ).fetchone()
        cached_dates = _decode_dates(row[0]) if row else set()
        if cached_dates or (row and row[2]):
            return cached_dates, "calendar_cache"
        if row and row[3] and _is_recent_attempt(row[1]):
            return set(), "weekend_fallback"
    finally:
        connection.close()

    try:
        fetch = fetcher or _fetch_nager_dates
        dates = fetch(year)
        _save_calendar_year(year, dates, error="")
        return dates, "nager_date"
    except (OSError, ValueError, urllib.error.URLError) as error:
        _save_calendar_year(year, set(), error=str(error)[:300])
        return set(), "weekend_fallback"


def _fetch_nager_dates(year: int) -> set[str]:
    request = urllib.request.Request(
        NAGER_DATE_URL.format(year=year), headers={"Accept": "application/json", "User-Agent": "JumpingBattle-SuwonYT/1.0"}
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise ValueError("unexpected holiday response")
    return {str(item.get("date")) for item in payload if isinstance(item, dict) and str(item.get("date", ""))}


def _save_calendar_year(year: int, dates: set[str], error: str) -> None:
    now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    connection = get_db_connection()
    try:
        connection.execute(
            """
            INSERT INTO reservation_holiday_calendar_years
                (calendar_year, dates_json, last_attempt_at, last_success_at, last_error)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(calendar_year) DO UPDATE SET
                dates_json=CASE WHEN excluded.dates_json='[]' THEN reservation_holiday_calendar_years.dates_json ELSE excluded.dates_json END,
                last_attempt_at=excluded.last_attempt_at,
                last_success_at=CASE WHEN excluded.last_success_at IS NULL THEN reservation_holiday_calendar_years.last_success_at ELSE excluded.last_success_at END,
                last_error=excluded.last_error
            """,
            (year, json.dumps(sorted(dates)), now_text, now_text if dates else None, error),
        )
        connection.commit()
    finally:
        connection.close()


def _decode_dates(raw: object) -> set[str]:
    try:
        decoded = json.loads(str(raw or "[]"))
    except json.JSONDecodeError:
        return set()
    return {value for value in decoded if isinstance(value, str)} if isinstance(decoded, list) else set()


def _is_recent_attempt(value: object) -> bool:
    try:
        attempted_at = datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return False
    return datetime.now() - attempted_at < RETRY_DELAY
