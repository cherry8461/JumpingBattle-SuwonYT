"""Smoke test for the Chrome extension reservation intake API."""

import os
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-naver-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")
os.environ["NAVER_AGENT_TOKEN"] = "test-naver-agent-token"
TEST_DATE = datetime.now().strftime("%Y.%m.%d")
TEST_DATE_KEY = TEST_DATE.replace(".", "-")

import app  # noqa: E402
from monitor_modules.naver_reservations import normalize_difficulty  # noqa: E402


class NaverReservationIntakeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        cls.client = app.web.test_client()

    def test_confirm_then_cancel(self):
        headers = {"x-jumping-agent-token": "test-naver-agent-token"}
        confirmed = self.client.post(
            "/api/integrations/naver/reservations",
            headers=headers,
            json={
                "items": [
                    {
                        "bookNo": "TEST-NAVER-1001",
                        "when": f"{TEST_DATE}. 오후 3:30",
                        "product": "점핑배틀 C1",
                        "status": "확정",
                        "name": "테스트고객",
                        "teamName": "테스트팀",
                        "difficulty": "중급",
                        "phone": "010-1234-5678",
                        "totalCount": 3,
                    }
                ]
            },
        )
        self.assertEqual(confirmed.status_code, 200)

        with sqlite3.connect(app.DB_FILE) as connection:
            cache_status = connection.execute(
                "SELECT status FROM naver_mail_cache WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()[0]
            reservation_status = connection.execute(
                "SELECT booking_status FROM naver_reservations WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()[0]
            reservation_detail = connection.execute(
                "SELECT team_name, difficulty, phone FROM naver_reservations WHERE booking_id=?",
                ("TEST-NAVER-1001",),
            ).fetchone()
        self.assertEqual(cache_status, "INIT")
        self.assertEqual(reservation_status, "CONFIRMED")
        self.assertEqual(reservation_detail, ("테스트팀", "중급", "01012345678"))

        today_items = self.client.get("/api/naver-bookings/today-init").get_json()
        self.assertEqual(len(today_items), 1)
        self.assertEqual(today_items[0]["team"], "테스트팀")
        self.assertEqual(today_items[0]["difficulty"], "중급")
        self.assertEqual(today_items[0]["phone"], "01012345678")
        self.assertEqual(today_items[0]["people"], 0)

        cancelled = self.client.post(
            "/api/integrations/naver/reservations",
            headers=headers,
            json={
                "items": [
                    {
                        "bookNo": "TEST-NAVER-1001",
                        "when": f"{TEST_DATE}. 오후 3:30",
                        "product": "점핑배틀 C1",
                        "status": "취소",
                        "name": "테스트고객",
                    }
                ]
            },
        )
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.get_json()["same_day_cancellations"], 1)

        with sqlite3.connect(app.DB_FILE) as connection:
            cache_row = connection.execute(
                "SELECT status FROM naver_mail_cache WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()
            reservation_status = connection.execute(
                "SELECT booking_status FROM naver_reservations WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()
            no_show_count = connection.execute(
                "SELECT no_show_count FROM settlement_daily_meta WHERE target_date=?", (TEST_DATE_KEY,)
            ).fetchone()[0]
        self.assertIsNone(cache_row)
        self.assertEqual(reservation_status[0], "CANCELED")
        self.assertEqual(no_show_count, 1)

        restored = self.client.post(
            "/api/integrations/naver/reservations",
            headers=headers,
            json={
                "items": [
                    {
                        "bookNo": "TEST-NAVER-1001",
                        "when": f"{TEST_DATE}. 오후 3:30",
                        "product": "점핑배틀 C1",
                        "status": "확정",
                        "name": "테스트고객",
                    }
                ]
            },
        )
        self.assertEqual(restored.status_code, 200)
        with sqlite3.connect(app.DB_FILE) as connection:
            restored_count = connection.execute(
                "SELECT no_show_count FROM settlement_daily_meta WHERE target_date=?", (TEST_DATE_KEY,)
            ).fetchone()[0]
            restored_cache = connection.execute(
                "SELECT status FROM naver_mail_cache WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()[0]
        self.assertEqual(restored_count, 0)
        self.assertEqual(restored_cache, "INIT")

    def test_naver_difficulty_description_uses_dashboard_label(self):
        self.assertEqual(
            normalize_difficulty("Basic (\ub09c\uc774\ub3c41) - \uc815\uaddc\ub9f5 / \ucd08\uc2ec\uc790 \ucd94\ucc9c"),
            "\ubca0\uc774\uc9c1",
        )
        self.assertEqual(normalize_difficulty("Normal (\ub09c\uc774\ub3c43)"), "\ub178\uba40")


if __name__ == "__main__":
    unittest.main()
