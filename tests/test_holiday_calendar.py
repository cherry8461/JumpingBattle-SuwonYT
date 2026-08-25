"""Tests for cached holiday resolution without live network access."""

import os
import tempfile
import unittest
from datetime import date
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-holiday-calendar-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")

import app  # noqa: E402
from monitor_modules.holiday_calendar import operating_day_type  # noqa: E402
from monitor_core.database import get_db_connection  # noqa: E402


class HolidayCalendarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()

    def test_fetches_once_then_uses_calendar_cache(self):
        calls = []

        def fetcher(year):
            calls.append(year)
            return {"2026-08-17"}

        first = operating_day_type(date(2026, 8, 17), fetcher=fetcher)
        second = operating_day_type(date(2026, 8, 18), fetcher=lambda year: self.fail("should use cache"))
        self.assertEqual(first, ("weekend_or_holiday", "nager_date"))
        self.assertEqual(second, ("weekday", "calendar_cache"))
        self.assertEqual(calls, [2026])

    def test_staff_override_beats_cached_holiday(self):
        with get_db_connection() as connection:
            connection.execute(
                "INSERT INTO day_type_overrides (target_date, day_type) VALUES ('2026-08-17', 'weekday')"
            )
        resolved = operating_day_type(date(2026, 8, 17), fetcher=lambda year: self.fail("override should skip fetch"))
        self.assertEqual(resolved, ("weekday", "staff_override"))


if __name__ == "__main__":
    unittest.main()
