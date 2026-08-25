"""Availability tests: public data only, never customer details."""

import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-customer-availability-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")

import app  # noqa: E402
from monitor_core.database import get_db_connection  # noqa: E402


class CustomerReservationAvailabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        cls.client = app.web.test_client()
        cls.target_date = date.today()
        with get_db_connection() as connection:
            connection.execute(
                """INSERT INTO self_reservations
                    (reservation_id, source, product_code, status, deposit_amount, refund_policy_code)
                   VALUES ('test-confirmed', 'customer_web', 'STANDARD_ROOM_DEPOSIT', 'confirmed', 5000, 'naver_mirror_pending')"""
            )
            connection.execute(
                "INSERT INTO reservation_holiday_calendar_years (calendar_year, dates_json, last_success_at) VALUES (?, ?, datetime('now'))",
                (cls.target_date.year, json.dumps([])),
            )

    def test_standard_room_endpoint_hides_confirmed_slot_without_personal_data(self):
        with get_db_connection() as connection:
            connection.execute(
                """INSERT INTO reservation_slots
                    (reservation_id, slot_date, time_key, room_id, slot_status)
                   VALUES ('test-confirmed', ?, '12:00', 'C1', 'confirmed')""",
                (self.target_date.isoformat(),),
            )
        response = self.client.get(
            f"/api/public-reservations/availability?date={self.target_date.isoformat()}&product=standard_room"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        c1 = next(room for room in payload["rooms"] if room["room_id"] == "C1")
        self.assertFalse(next(slot for slot in c1["slots"] if slot["start_time"] == "12:00")["available"])
        self.assertNotIn("customer_name", json.dumps(payload))

    def test_weekend_party_room_has_only_two_slots(self):
        saturday = date.today()
        while saturday.weekday() != 5:
            from datetime import timedelta
            saturday += timedelta(days=1)
        response = self.client.get(
            f"/api/public-reservations/availability?date={saturday.isoformat()}&product=party_room&room_size=small"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["start_time"] for item in response.get_json()["slots"]], ["11:00", "19:00"])

    def test_existing_naver_booking_also_blocks_its_room_time_during_migration(self):
        with get_db_connection() as connection:
            connection.execute(
                """INSERT INTO naver_reservations
                    (booking_id, booking_status, use_date, use_time_key, room_name)
                   VALUES ('test-naver-conflict', 'CONFIRMED', ?, '12-20', 'C2')""",
                (self.target_date.isoformat(),),
            )
        response = self.client.get(
            f"/api/public-reservations/availability?date={self.target_date.isoformat()}&product=standard_room"
        )
        c2 = next(room for room in response.get_json()["rooms"] if room["room_id"] == "C2")
        self.assertFalse(next(slot for slot in c2["slots"] if slot["start_time"] == "12:20")["available"])


if __name__ == "__main__":
    unittest.main()
