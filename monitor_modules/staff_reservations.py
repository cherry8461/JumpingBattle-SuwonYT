"""Staff-only preparation tools for the future self-reservation service."""

from __future__ import annotations

import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime
from functools import wraps

from flask import Blueprint, abort, jsonify, redirect, render_template, request, session, url_for

from monitor_core.database import get_db_connection
from .self_reservation_schema import PARTY_RENTAL_POLICY


def create_staff_reservations_blueprint() -> Blueprint:
    blueprint = Blueprint("staff_reservations", __name__)

    def require_staff(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not session.get("reservation_staff_authenticated"):
                return redirect(url_for("staff_reservations.login", next=request.path))
            return view(*args, **kwargs)

        return wrapped

    @blueprint.route("/reservation-admin/login", methods=["GET", "POST"])
    def login():
        configured_password = os.getenv("RESERVATION_ADMIN_PASSWORD", "")
        if not configured_password:
            abort(503, "RESERVATION_ADMIN_PASSWORD is not configured.")

        error = ""
        if request.method == "POST":
            password = request.form.get("password", "")
            if hmac.compare_digest(password, configured_password):
                session.clear()
                session["reservation_staff_authenticated"] = True
                session.permanent = True
                return redirect(request.form.get("next") or url_for("staff_reservations.dashboard"))
            error = "비밀번호가 올바르지 않습니다."
        return render_template("reservation_admin_login.html", error=error, next=request.args.get("next", ""))

    @blueprint.post("/reservation-admin/logout")
    def logout():
        session.clear()
        return redirect(url_for("staff_reservations.login"))

    @blueprint.get("/reservation-admin")
    @require_staff
    def dashboard():
        with get_db_connection() as connection:
            connection.row_factory = sqlite3.Row
            products = [dict(row) for row in connection.execute(
                """
                SELECT product_code, display_name, reservation_type, deposit_amount,
                       amount_mode, requires_room, staff_created_only, active
                  FROM reservation_products
                 ORDER BY sort_order, product_code
                """
            ).fetchall()]
            rules = [dict(row) for row in connection.execute(
                """
                SELECT min_days_before, max_days_before, refund_rate_percent, penalty_rate_percent
                  FROM reservation_refund_rules
                 WHERE policy_code=?
                 ORDER BY min_days_before
                """,
                (PARTY_RENTAL_POLICY,),
            ).fetchall()]
            pending_orders = [dict(row) for row in connection.execute(
                """
                SELECT o.order_id, o.amount, o.status, o.created_at,
                       r.customer_name, r.customer_phone, r.staff_note
                  FROM payment_orders AS o
                  JOIN self_reservations AS r ON r.reservation_id=o.reservation_id
                 WHERE r.product_code='RENTAL_DEPOSIT'
                 ORDER BY o.created_at DESC
                 LIMIT 20
                """
            ).fetchall()]
        return render_template(
            "reservation_admin.html",
            products=products,
            rules=rules,
            pending_orders=pending_orders,
        )

    @blueprint.post("/api/reservation-admin/rental-deposit-orders")
    @require_staff
    def create_rental_deposit_order():
        body = request.get_json(silent=True) or {}
        name = _clean_text(body.get("customer_name"), 80)
        phone = _normalise_phone(body.get("customer_phone"))
        note = _clean_text(body.get("staff_note"), 500)
        amount = _safe_amount(body.get("amount"))
        if not name or not phone or amount < 1000:
            return jsonify(success=False, message="성함, 연락처, 1,000원 이상의 예약금을 확인하세요."), 400

        reservation_id = f"rental-{secrets.token_urlsafe(12)}"
        order_id = f"order-{secrets.token_urlsafe(12)}"
        policy_snapshot = _policy_snapshot()
        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with get_db_connection() as connection:
            connection.execute(
                """
                INSERT INTO self_reservations (
                    reservation_id, source, product_code, status, customer_name,
                    customer_phone, staff_note, deposit_amount, refund_policy_code,
                    refund_policy_snapshot_json, created_at, updated_at
                ) VALUES (?, 'staff', 'RENTAL_DEPOSIT', 'payment_pending', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (reservation_id, name, phone, note, amount, PARTY_RENTAL_POLICY, policy_snapshot, now_text, now_text),
            )
            connection.execute(
                """
                INSERT INTO payment_orders (
                    order_id, reservation_id, status, amount, idempotency_key, created_at, updated_at
                ) VALUES (?, ?, 'created', ?, ?, ?, ?)
                """,
                (order_id, reservation_id, amount, secrets.token_urlsafe(24), now_text, now_text),
            )

        return jsonify(success=True, order_id=order_id, reservation_id=reservation_id, amount=amount)

    return blueprint


def _policy_snapshot() -> str:
    with get_db_connection() as connection:
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(
            """
            SELECT min_days_before, max_days_before, refund_rate_percent, penalty_rate_percent
              FROM reservation_refund_rules
             WHERE policy_code=?
             ORDER BY min_days_before
            """,
            (PARTY_RENTAL_POLICY,),
        ).fetchall()]
    return json.dumps({"policy_code": PARTY_RENTAL_POLICY, "rules": rows}, ensure_ascii=False, separators=(",", ":"))


def _clean_text(value: object, max_length: int) -> str:
    return " ".join(str(value or "").split())[:max_length]


def _normalise_phone(value: object) -> str:
    digits = "".join(character for character in str(value or "") if character.isdigit())
    return digits if 9 <= len(digits) <= 12 else ""


def _safe_amount(value: object) -> int:
    try:
        amount = int(value)
    except (TypeError, ValueError):
        return 0
    return min(max(amount, 0), 10_000_000)
