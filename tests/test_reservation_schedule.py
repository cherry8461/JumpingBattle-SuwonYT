"""Agreed operating-time rules for the customer reservation service."""

from datetime import date
import unittest

from monitor_modules.reservation_schedule import (
    WEEKDAY,
    WEEKEND_OR_HOLIDAY,
    day_type,
    party_room_slots,
    standard_room_slots,
)


class ReservationScheduleTest(unittest.TestCase):
    def test_standard_rooms_use_twenty_minute_slots_and_day_type_hours(self):
        weekday_slots = standard_room_slots(date(2026, 8, 25))
        holiday_slots = standard_room_slots(date(2026, 8, 17), is_public_holiday=True)
        self.assertEqual((weekday_slots[0], weekday_slots[-1], len(weekday_slots)), ("12:00", "22:40", 33))
        self.assertEqual((holiday_slots[0], holiday_slots[-1], len(holiday_slots)), ("10:00", "22:40", 39))

    def test_party_room_has_weekday_sequence_and_two_weekend_holiday_starts(self):
        weekday = party_room_slots(date(2026, 8, 25))
        weekend = party_room_slots(date(2026, 8, 29))
        holiday = party_room_slots(date(2026, 8, 17), is_public_holiday=True)
        self.assertEqual([slot["start_time"] for slot in weekday], ["12:00", "14:30", "17:00", "19:30"])
        self.assertEqual([slot["start_time"] for slot in weekend], ["11:00", "19:00"])
        self.assertEqual(holiday, weekend)
        self.assertEqual(weekday[-1]["end_time"], "21:30")
        self.assertEqual(weekday[-1]["turnaround_end_time"], "22:00")

    def test_staff_exception_can_override_calendar_classification(self):
        saturday = date(2026, 8, 29)
        self.assertEqual(day_type(saturday), WEEKEND_OR_HOLIDAY)
        self.assertEqual(day_type(saturday, staff_override=WEEKDAY), WEEKDAY)


if __name__ == "__main__":
    unittest.main()
