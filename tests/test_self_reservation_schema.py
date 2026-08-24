"""Contract tests for the self-reservation and payment database foundation."""

import sqlite3
import unittest

from monitor_modules.self_reservation_schema import ensure_self_reservation_schema


class SelfReservationSchemaTest(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute("CREATE TABLE rooms (room_id TEXT PRIMARY KEY)")
        ensure_self_reservation_schema(self.connection.cursor())

    def tearDown(self):
        self.connection.close()

    def test_products_keep_the_agreed_deposit_amounts_and_roles(self):
        products = dict(
            self.connection.execute(
                "SELECT product_code, deposit_amount FROM reservation_products"
            ).fetchall()
        )
        self.assertEqual(products["STANDARD_ROOM_DEPOSIT"], 5000)
        self.assertEqual(products["PARTY_ROOM_DEPOSIT"], 50000)
        rental = self.connection.execute(
            "SELECT requires_room, staff_created_only, amount_mode FROM reservation_products "
            "WHERE product_code='RENTAL_DEPOSIT'"
        ).fetchone()
        self.assertEqual(rental, (0, 1, "staff_defined"))

    def test_party_and_rental_refund_schedule(self):
        rows = self.connection.execute(
            "SELECT min_days_before, max_days_before, refund_rate_percent, penalty_rate_percent "
            "FROM reservation_refund_rules WHERE policy_code='party_rental_v1' "
            "ORDER BY min_days_before"
        ).fetchall()
        self.assertEqual(
            rows,
            [(0, 0, 0, 100), (1, 2, 50, 50), (3, 3, 70, 30),
             (4, 4, 80, 20), (5, 5, 90, 10), (6, None, 100, 0)],
        )


if __name__ == "__main__":
    unittest.main()
