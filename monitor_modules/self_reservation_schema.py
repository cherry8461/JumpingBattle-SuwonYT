"""Schema foundation for the future customer booking and deposit-payment service.

These tables deliberately do not replace the existing local ``bookings`` table.
That table remains the store operation record; this module owns the lifecycle of
an online reservation, its payment, cancellation and refund.
"""

from __future__ import annotations

import sqlite3


PARTY_RENTAL_POLICY = "party_rental_v1"
NAVER_MIRROR_POLICY = "naver_mirror_pending"


def ensure_self_reservation_schema(cursor: sqlite3.Cursor) -> None:
    """Create additive tables and seed the agreed reservation-deposit policies."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS reservation_refund_policies (
            policy_code TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            calculation_basis TEXT NOT NULL DEFAULT 'use_date_calendar_day',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS reservation_refund_rules (
            policy_code TEXT NOT NULL,
            min_days_before INTEGER NOT NULL,
            max_days_before INTEGER,
            refund_rate_percent INTEGER NOT NULL CHECK(refund_rate_percent BETWEEN 0 AND 100),
            penalty_rate_percent INTEGER NOT NULL CHECK(penalty_rate_percent BETWEEN 0 AND 100),
            PRIMARY KEY (policy_code, min_days_before),
            FOREIGN KEY(policy_code) REFERENCES reservation_refund_policies(policy_code)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS reservation_products (
            product_code TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            reservation_type TEXT NOT NULL CHECK(reservation_type IN ('standard_room', 'party_room', 'rental_deposit')),
            deposit_amount INTEGER NOT NULL DEFAULT 0 CHECK(deposit_amount >= 0),
            amount_mode TEXT NOT NULL DEFAULT 'fixed' CHECK(amount_mode IN ('fixed', 'staff_defined')),
            requires_room INTEGER NOT NULL DEFAULT 1,
            staff_created_only INTEGER NOT NULL DEFAULT 0,
            refund_policy_code TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(refund_policy_code) REFERENCES reservation_refund_policies(policy_code)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS self_reservations (
            reservation_id TEXT PRIMARY KEY,
            source TEXT NOT NULL CHECK(source IN ('customer_web', 'walkin', 'staff')),
            product_code TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('hold', 'payment_pending', 'confirmed', 'cancelled', 'refund_pending', 'refunded', 'expired')),
            use_date TEXT,
            start_time TEXT,
            end_time TEXT,
            room_id TEXT,
            customer_name TEXT NOT NULL DEFAULT '',
            customer_phone TEXT NOT NULL DEFAULT '',
            team_name TEXT NOT NULL DEFAULT '',
            people_count INTEGER,
            staff_note TEXT NOT NULL DEFAULT '',
            deposit_amount INTEGER NOT NULL CHECK(deposit_amount >= 0),
            refund_policy_code TEXT NOT NULL,
            refund_policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
            hold_expires_at TIMESTAMP,
            confirmed_at TIMESTAMP,
            cancelled_at TIMESTAMP,
            cancellation_reason TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(product_code) REFERENCES reservation_products(product_code),
            FOREIGN KEY(room_id) REFERENCES rooms(room_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS reservation_slots (
            reservation_id TEXT NOT NULL,
            slot_date TEXT NOT NULL,
            time_key TEXT NOT NULL,
            room_id TEXT NOT NULL,
            slot_status TEXT NOT NULL CHECK(slot_status IN ('hold', 'confirmed', 'released')),
            expires_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (reservation_id, slot_date, time_key, room_id),
            FOREIGN KEY(reservation_id) REFERENCES self_reservations(reservation_id),
            FOREIGN KEY(room_id) REFERENCES rooms(room_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_orders (
            order_id TEXT PRIMARY KEY,
            reservation_id TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT '',
            provider_payment_key TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK(status IN ('created', 'approval_pending', 'paid', 'cancel_pending', 'cancelled', 'failed', 'expired')),
            amount INTEGER NOT NULL CHECK(amount >= 0),
            currency TEXT NOT NULL DEFAULT 'KRW',
            method TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT NOT NULL UNIQUE,
            approved_at TIMESTAMP,
            cancelled_at TIMESTAMP,
            failure_code TEXT NOT NULL DEFAULT '',
            failure_message TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(reservation_id) REFERENCES self_reservations(reservation_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_refunds (
            refund_id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK(amount >= 0),
            penalty_amount INTEGER NOT NULL CHECK(penalty_amount >= 0),
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK(status IN ('requested', 'completed', 'failed')),
            provider_refund_key TEXT NOT NULL DEFAULT '',
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES payment_orders(order_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS reservation_holiday_calendar_years (
            calendar_year INTEGER PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'nager_date',
            dates_json TEXT NOT NULL DEFAULT '[]',
            last_attempt_at TIMESTAMP,
            last_success_at TIMESTAMP,
            last_error TEXT NOT NULL DEFAULT ''
        )
        """
    )
    party_rooms = [
        ("PARTY_SMALL", "파티룸 소형"),
        ("PARTY_MEDIUM", "파티룸 중형"),
        ("PARTY_LARGE", "파티룸 대형"),
    ]
    room_columns = {row[1] for row in cursor.execute("PRAGMA table_info(rooms)").fetchall()}
    if {"display_name", "agent_mode", "enabled"}.issubset(room_columns):
        cursor.executemany(
            """INSERT OR IGNORE INTO rooms (room_id, display_name, agent_mode, enabled)
               VALUES (?, ?, 'not_applicable', 1)""",
            party_rooms,
        )
    else:
        # The minimal table is used by schema-only tests.  The real application
        # has the richer room metadata columns handled above.
        cursor.executemany(
            "INSERT OR IGNORE INTO rooms (room_id) VALUES (?)",
            [(room_id,) for room_id, _ in party_rooms],
        )

    cursor.executemany(
        """
        INSERT OR IGNORE INTO reservation_refund_policies (policy_code, display_name)
        VALUES (?, ?)
        """,
        [
            (NAVER_MIRROR_POLICY, "일반 방 - 네이버 규정 동기화 대기"),
            (PARTY_RENTAL_POLICY, "파티룸·대관 예약금 취소 규정 v1"),
        ],
    )
    cursor.executemany(
        """
        INSERT OR IGNORE INTO reservation_refund_rules
            (policy_code, min_days_before, max_days_before, refund_rate_percent, penalty_rate_percent)
        VALUES (?, ?, ?, ?, ?)
        """,
        [
            (PARTY_RENTAL_POLICY, 0, 0, 0, 100),
            (PARTY_RENTAL_POLICY, 1, 2, 50, 50),
            (PARTY_RENTAL_POLICY, 3, 3, 70, 30),
            (PARTY_RENTAL_POLICY, 4, 4, 80, 20),
            (PARTY_RENTAL_POLICY, 5, 5, 90, 10),
            (PARTY_RENTAL_POLICY, 6, None, 100, 0),
        ],
    )
    cursor.executemany(
        """
        INSERT OR IGNORE INTO reservation_products
            (product_code, display_name, reservation_type, deposit_amount, amount_mode,
             requires_room, staff_created_only, refund_policy_code, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            ("STANDARD_ROOM_DEPOSIT", "일반 방 예약금", "standard_room", 5000, "fixed", 1, 0, NAVER_MIRROR_POLICY, 10),
            ("PARTY_ROOM_DEPOSIT", "파티룸 예약금", "party_room", 50000, "fixed", 1, 0, PARTY_RENTAL_POLICY, 20),
            ("RENTAL_DEPOSIT", "대관 예약금", "rental_deposit", 0, "staff_defined", 0, 1, PARTY_RENTAL_POLICY, 30),
        ],
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_self_reservations_status_date
            ON self_reservations(status, use_date, start_time)
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_reservation_slots_lookup
            ON reservation_slots(slot_date, room_id, time_key, slot_status)
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_payment_orders_reservation_status
            ON payment_orders(reservation_id, status, created_at)
        """
    )
