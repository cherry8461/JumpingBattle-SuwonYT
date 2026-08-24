"""Centralised local settings.

Only non-secret defaults belong here. Real credentials stay in the ignored .env file.
"""

import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DATA_DIR = Path(os.getenv("GAME_MONITOR_DATA_DIR", PROJECT_ROOT / "data")).resolve()
DB_FILE = Path(os.getenv("GAME_MONITOR_DB_PATH", DATA_DIR / "game_data.db")).resolve()
SERVER_LOG_DIR = Path(
    os.getenv(
        "GAME_MANAGER_LOG_DIR",
        r"D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager\file\log",
    )
).resolve()
LOG_DIR = Path(os.getenv("GAME_MONITOR_LOG_DIR", PROJECT_ROOT / "logs")).resolve()
SERVER_HOST = os.getenv("GAME_MONITOR_HOST", "127.0.0.1")
SERVER_PORT = int(os.getenv("GAME_MONITOR_PORT", "8081"))
