"""Create a safe, consistent SQLite backup of the new operation database.

This script only creates a backup. It never removes old backups automatically.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path(os.getenv("GAME_MONITOR_DB_PATH", PROJECT_ROOT / "data" / "game_data.db"))
DEFAULT_DESTINATION = PROJECT_ROOT / "database_backup"


def main() -> int:
    parser = argparse.ArgumentParser(description="Back up the Suwon Yeongtong SQLite database.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()

    source = args.source.resolve()
    destination = args.destination.resolve()
    if not source.is_file():
        raise SystemExit(f"Database was not found: {source}")

    destination.mkdir(parents=True, exist_ok=True)
    target = destination / f"game_data-{datetime.now():%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(source) as source_connection:
        with sqlite3.connect(target) as backup_connection:
            source_connection.backup(backup_connection)
    print(f"Backup created: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
