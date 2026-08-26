import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="jumpingbattle-walkin-intake-test-"))
os.environ["GAME_MONITOR_DB_PATH"] = str(TEST_ROOT / "game_data.db")
os.environ["GAME_MONITOR_LOG_DIR"] = str(TEST_ROOT / "logs")
os.environ["TEAM_LIST_PASSWORD"] = "test-only-team-list-password"

import app  # noqa: E402


class WalkinIntakeSnapshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        with sqlite3.connect(app.DB_FILE) as connection:
            connection.execute("ALTER TABLE walkins ADD COLUMN visit_date TEXT")
            connection.execute("ALTER TABLE walkins ADD COLUMN visit_time TEXT")
            connection.execute(
                '''
                INSERT INTO walkins (
                    name, team, level, people, room_size, room_fast,
                    initial_level, initial_room_size, initial_room_fast,
                    phone, visit_date, visit_time, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    "테스트", "원본팀", "베이직", 3, "소형", 0,
                    "베이직", "소형", 0,
                    "010", "2026-08-26", "12:00:00", "entered",
                ),
            )
            # This represents a later dashboard/game-card edit.
            connection.execute(
                "UPDATE walkins SET level=?, room_size=?, room_fast=? WHERE team=?",
                ("하드", "대형", 1, "원본팀"),
            )

        cls.client = app.web.test_client()
        cls.client.post("/team_list/login", data={"password": "test-only-team-list-password"})

    def test_history_shows_initial_level_and_room_size(self):
        response = self.client.get("/api/walkin/history?date=2026-08-26")
        self.assertEqual(response.status_code, 200)
        item = response.get_json()[0]
        self.assertEqual(item["level"], "베이직")
        self.assertEqual(item["room_flag_label"], "소형")


if __name__ == "__main__":
    unittest.main()
