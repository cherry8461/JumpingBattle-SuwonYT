import json
import unittest
from datetime import date, datetime, timedelta

from monitor_modules.reservation_refunds import quote_refund


POLICY = json.dumps(
    {
        "rules": [
            {"min_days_before": 0, "max_days_before": 0, "refund_rate_percent": 0},
            {"min_days_before": 1, "max_days_before": 2, "refund_rate_percent": 50},
            {"min_days_before": 3, "max_days_before": 3, "refund_rate_percent": 70},
            {"min_days_before": 4, "max_days_before": 4, "refund_rate_percent": 80},
            {"min_days_before": 5, "max_days_before": 5, "refund_rate_percent": 90},
            {"min_days_before": 6, "max_days_before": None, "refund_rate_percent": 100},
        ]
    }
)


class RefundQuoteTest(unittest.TestCase):
    def test_party_rental_schedule(self):
        cancelled_at = datetime(2026, 8, 26, 11, 0)
        cases = [(0, 0), (1, 25_000), (2, 25_000), (3, 35_000), (4, 40_000), (5, 45_000), (6, 50_000)]
        for days_before, expected_refund in cases:
            with self.subTest(days_before=days_before):
                use_date = date(2026, 8, 26) + timedelta(days=days_before)
                quote = quote_refund(50_000, use_date, POLICY, cancelled_at)
                self.assertEqual(quote.refund_amount, expected_refund)
                self.assertEqual(quote.penalty_amount, 50_000 - expected_refund)

    def test_same_day_is_not_refundable(self):
        quote = quote_refund(5_000, "2026-08-26", POLICY, datetime(2026, 8, 26, 1, 0))
        self.assertEqual(quote.refund_rate_percent, 0)
        self.assertEqual(quote.refund_amount, 0)


if __name__ == "__main__":
    unittest.main()
