"""Smoke test for the Chrome extension reservation intake API."""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-naver-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")
os.environ["NAVER_AGENT_TOKEN"] = "test-naver-agent-token"

import app  # noqa: E402


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
                        "when": "2026.08.24. 오후 3:30",
                        "product": "점핑배틀 C1",
                        "status": "확정",
                        "name": "테스트고객",
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
        self.assertEqual(cache_status, "INIT")
        self.assertEqual(reservation_status, "CONFIRMED")

        cancelled = self.client.post(
            "/api/integrations/naver/reservations",
            headers=headers,
            json={
                "items": [
                    {
                        "bookNo": "TEST-NAVER-1001",
                        "when": "2026.08.24. 오후 3:30",
                        "product": "점핑배틀 C1",
                        "status": "취소",
                        "name": "테스트고객",
                    }
                ]
            },
        )
        self.assertEqual(cancelled.status_code, 200)

        with sqlite3.connect(app.DB_FILE) as connection:
            cache_status = connection.execute(
                "SELECT status FROM naver_mail_cache WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()[0]
            reservation_status = connection.execute(
                "SELECT booking_status FROM naver_reservations WHERE booking_id=?", ("TEST-NAVER-1001",)
            ).fetchone()[0]
        self.assertEqual(cache_status, "CANCELED")
        self.assertEqual(reservation_status, "CANCELED")


if __name__ == "__main__":
    unittest.main()
