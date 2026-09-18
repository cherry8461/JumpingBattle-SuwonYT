"""SQLite connection helpers shared by web and background jobs."""

import sqlite3

from .settings import DB_FILE

DEFAULT_BUSY_TIMEOUT_SECONDS = 60


def get_db_connection(timeout: int = DEFAULT_BUSY_TIMEOUT_SECONDS) -> sqlite3.Connection:
    """Open the local database with predictable concurrent-access settings."""
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_FILE, timeout=timeout)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(f"PRAGMA busy_timeout = {max(1, int(timeout * 1000))}")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection
