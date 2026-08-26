import os
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-naver-card-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")
os.environ["NAVER_AGENT_TOKEN"] = "test-naver-agent-token"
os.environ["TEAM_LIST_PASSWORD"] = "test-team-list-password"

import app  # noqa: E402


class NaverCardHandlingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        cls.client = app.web.test_client()
        cls.headers = {"x-jumping-agent-token": "test-naver-agent-token"}
        cls.date_text = datetime.now().strftime("%Y.%m.%d")
        cls.date_key = cls.date_text.replace(".", "-")

    def send(self, booking_id, status):
        return self.client.post(
            "/api/integrations/naver/reservations",
            headers=self.headers,
            json={"items": [{
                "bookNo": booking_id,
                "when": f"{self.date_text}. 오후 3:30",
                "product": "소형방 C1",
                "status": status,
                "name": "테스트 고객",
                "teamName": "테스트팀",
                "difficulty": "Basic (난이도1)",
                "phone": "010-1234-5678",
            }]},
        )

    def add_linked_card(self, booking_id):
        response = self.client.post(
            "/api/booking/add",
            json={
                "booking_date": self.date_key,
                "time_key": "15-30",
                "room": "C1",
                "name": "테스트 고객",
                "team": "테스트팀",
                "level": "베이직",
                "people": "",
                "payment_data": "{}",
                "naver_booking_id": booking_id,
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.get_json()["id"]

    def test_customer_cancellation_hides_linked_game_card_and_counts_once(self):
        booking_id = "TEST-CARD-CUSTOMER"
        self.assertEqual(self.send(booking_id, "확정").status_code, 200)
        self.add_linked_card(booking_id)

        cancelled = self.send(booking_id, "취소")
        self.assertEqual(cancelled.get_json()["same_day_cancellations"], 1)
        self.assertEqual(self.client.get(f"/api/booking/list?date={self.date_key}").get_json(), [])
        with sqlite3.connect(app.DB_FILE) as connection:
            state = connection.execute(
                "SELECT card_state FROM naver_booking_card_links WHERE booking_id=?", (booking_id,)
            ).fetchone()[0]
        self.assertEqual(state, "cancelled_hidden")

    def test_onsite_payment_conversion_keeps_game_card_and_does_not_count(self):
        booking_id = "TEST-CARD-ONSITE"
        self.assertEqual(self.send(booking_id, "확정").status_code, 200)
        self.add_linked_card(booking_id)
        self.client.post("/team_list/login", data={"password": "test-team-list-password"})
        converted = self.client.post(f"/api/naver-reservations/{booking_id}/onsite-payment")
        self.assertEqual(converted.status_code, 200)

        with sqlite3.connect(app.DB_FILE) as connection:
            before = connection.execute(
                "SELECT COALESCE(no_show_count, 0) FROM settlement_daily_meta WHERE target_date=?", (self.date_key,)
            ).fetchone()
            before_count = before[0] if before else 0

        cancelled = self.send(booking_id, "취소")
        self.assertEqual(cancelled.get_json()["same_day_cancellations"], 0)
        self.assertEqual(len(self.client.get(f"/api/booking/list?date={self.date_key}").get_json()), 1)
        with sqlite3.connect(app.DB_FILE) as connection:
            mode, state = connection.execute(
                "SELECT handling_mode, card_state FROM naver_booking_card_links WHERE booking_id=?", (booking_id,)
            ).fetchone()
            after = connection.execute(
                "SELECT COALESCE(no_show_count, 0) FROM settlement_daily_meta WHERE target_date=?", (self.date_key,)
            ).fetchone()[0]
        self.assertEqual((mode, state), ("onsite_payment", "active"))
        self.assertEqual(after, before_count)


if __name__ == "__main__":
    unittest.main()
