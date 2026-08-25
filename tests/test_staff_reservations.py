"""Tests for the staff-only rental deposit preparation flow."""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-staff-reservation-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")
os.environ["RESERVATION_ADMIN_PASSWORD"] = "test-staff-password"

import app  # noqa: E402


class StaffReservationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        cls.client = app.web.test_client()

    def test_staff_can_create_a_rental_deposit_payment_pending_order(self):
        login = self.client.post(
            "/reservation-admin/login",
            data={"password": "test-staff-password"},
            follow_redirects=False,
        )
        self.assertEqual(login.status_code, 302)
        created = self.client.post(
            "/api/reservation-admin/rental-deposit-orders",
            json={
                "customer_name": "테스트 고객",
                "customer_phone": "010-1234-5678",
                "amount": 75000,
                "staff_note": "테스트 대관 예약금",
            },
        )
        self.assertEqual(created.status_code, 200)
        payload = created.get_json()
        self.assertTrue(payload["success"])
        with sqlite3.connect(app.DB_FILE) as connection:
            reservation = connection.execute(
                "SELECT source, product_code, status, deposit_amount, room_id FROM self_reservations"
            ).fetchone()
            order = connection.execute("SELECT status, amount FROM payment_orders").fetchone()
        self.assertEqual(reservation, ("staff", "RENTAL_DEPOSIT", "payment_pending", 75000, None))
        self.assertEqual(order, ("created", 75000))


if __name__ == "__main__":
    unittest.main()
