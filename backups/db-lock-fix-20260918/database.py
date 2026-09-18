"""SQLite connection helpers shared by web and background jobs."""

import sqlite3

from .settings import DB_FILE


def get_db_connection(timeout: int = 30) -> sqlite3.Connection:
    """Open the local database with predictable concurrent-access settings."""
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_FILE, timeout=timeout)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection
