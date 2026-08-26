"""Deterministic refund calculation for self-reservation deposits.

This module intentionally does not call a payment provider.  It calculates the
refund that must be requested from the provider after a customer cancellation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any


@dataclass(frozen=True)
class RefundQuote:
    days_before: int
    refund_rate_percent: int
    refund_amount: int
    penalty_amount: int


def quote_refund(
    deposit_amount: int,
    use_date: str | date,
    policy_snapshot_json: str | dict[str, Any],
    cancelled_at: datetime | None = None,
) -> RefundQuote:
    """Return the policy-preserving refund quote for one cancellation.

    The policy snapshot stored with the reservation is used rather than the
    current policy table, so a later policy edit cannot change an existing
    customer's agreed refund amount.
    """
    amount = max(int(deposit_amount), 0)
    target_date = _to_date(use_date)
    cancellation_date = (cancelled_at or datetime.now()).date()
    days_before = max((target_date - cancellation_date).days, 0)
    rules = _rules_from_snapshot(policy_snapshot_json)
    rule = next((item for item in rules if _matches(item, days_before)), None)
    if rule is None:
        raise ValueError("Refund policy does not include this cancellation date.")

    refund_rate = int(rule["refund_rate_percent"])
    refund_amount = amount * refund_rate // 100
    return RefundQuote(
        days_before=days_before,
        refund_rate_percent=refund_rate,
        refund_amount=refund_amount,
        penalty_amount=amount - refund_amount,
    )


def _to_date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _rules_from_snapshot(value: str | dict[str, Any]) -> list[dict[str, Any]]:
    parsed = json.loads(value) if isinstance(value, str) else value
    rules = parsed.get("rules", []) if isinstance(parsed, dict) else []
    if not isinstance(rules, list):
        raise ValueError("Invalid refund policy snapshot.")
    return [item for item in rules if isinstance(item, dict)]


def _matches(rule: dict[str, Any], days_before: int) -> bool:
    minimum = int(rule["min_days_before"])
    maximum = rule.get("max_days_before")
    return days_before >= minimum and (maximum is None or days_before <= int(maximum))
