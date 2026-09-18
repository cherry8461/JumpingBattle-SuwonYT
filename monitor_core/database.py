"""SQLite connection helpers shared by web and background jobs."""

import logging
from logging.handlers import RotatingFileHandler
import random
import sqlite3
import threading
import time
import traceback
from contextlib import contextmanager

from .settings import DB_FILE, LOG_DIR

DEFAULT_BUSY_TIMEOUT_SECONDS = 3
_WRITE_LOCK = threading.RLock()
_META_LOCK = threading.Lock()
_ACTIVE_WRITER = None
_METRICS = {
    "connections": 0,
    "writes": 0,
    "waits": 0,
    "max_wait_ms": 0,
    "slow_transactions": 0,
    "busy_retries": 0,
    "errors": 0,
}
_LAST_SUMMARY_AT = time.monotonic()
_STATE_LOGGED = False


def _build_diagnostic_logger() -> logging.Logger:
    """Create a bounded, privacy-safe DB diagnostic log.

    The logger intentionally records operation names and call sites, but never
    SQL parameters (team names, phone numbers, tokens, etc.).
    """
    logger = logging.getLogger("suwonyt.database")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = (LOG_DIR / "database-diagnostics.log").resolve()
    if not any(
        isinstance(handler, RotatingFileHandler)
        and getattr(handler, "baseFilename", None) == str(log_path)
        for handler in logger.handlers
    ):
        handler = RotatingFileHandler(
            log_path,
            maxBytes=5 * 1024 * 1024,
            backupCount=10,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s.%(msecs)03d %(levelname)s "
            "pid=%(process)d thread=%(threadName)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        logger.addHandler(handler)
    return logger


_LOGGER = _build_diagnostic_logger()


def _caller() -> str:
    """Return the closest application call site only for abnormal events."""
    for frame in reversed(traceback.extract_stack(limit=14)[:-1]):
        normalized = frame.filename.replace("\\", "/")
        if not normalized.endswith("/monitor_core/database.py"):
            return f"{frame.filename}:{frame.lineno}:{frame.name}"
    return "unknown"


def _sql_kind(sql: object) -> str:
    if not isinstance(sql, str):
        return "UNKNOWN"
    stripped = sql.lstrip()
    return (stripped.split(None, 1)[0] if stripped else "EMPTY").upper()[:24]


def _log_sql_error(sql: object, error: BaseException) -> None:
    """Record enough context to diagnose a failure without logging values."""
    _metric("errors")
    _LOGGER.error(
        "event=sql_error error_type=%s kind=%s error=%r caller=%s",
        type(error).__name__, _sql_kind(sql), str(error), _caller(),
        exc_info=True,
    )


def _metric(name: str, value: int = 1, *, maximum: bool = False) -> None:
    global _LAST_SUMMARY_AT
    with _META_LOCK:
        if maximum:
            _METRICS[name] = max(_METRICS[name], value)
        else:
            _METRICS[name] += value
        now = time.monotonic()
        if now - _LAST_SUMMARY_AT < 300:
            return
        summary = dict(_METRICS)
        _LAST_SUMMARY_AT = now
    _LOGGER.info(
        "event=summary db=%s connections=%d writes=%d waits=%d max_wait_ms=%d "
        "slow_transactions=%d busy_retries=%d errors=%d",
        DB_FILE, summary["connections"], summary["writes"], summary["waits"],
        summary["max_wait_ms"], summary["slow_transactions"],
        summary["busy_retries"], summary["errors"],
    )


def _is_write_statement(sql: object) -> bool:
    """Return True when a statement can start or change a transaction."""
    if not isinstance(sql, str):
        return False
    statement = sql.lstrip().upper()
    while statement.startswith("--"):
        _, _, statement = statement.partition("\n")
        statement = statement.lstrip().upper()
    return not statement.startswith(("SELECT", "PRAGMA", "EXPLAIN"))


class SerializedCursor(sqlite3.Cursor):
    """Cursor that enters the process-wide writer lane before a write."""

    def execute(self, sql, parameters=()):
        self.connection._before_statement(sql)
        try:
            return super().execute(sql, parameters)
        except sqlite3.Error as error:
            _log_sql_error(sql, error)
            raise

    def executemany(self, sql, seq_of_parameters):
        self.connection._before_statement(sql)
        try:
            return super().executemany(sql, seq_of_parameters)
        except sqlite3.Error as error:
            _log_sql_error(sql, error)
            raise

    def executescript(self, sql_script):
        self.connection._before_statement(sql_script)
        try:
            return super().executescript(sql_script)
        except sqlite3.Error as error:
            _log_sql_error(sql_script, error)
            raise


class SerializedConnection(sqlite3.Connection):
    """SQLite connection that serializes every in-process write transaction.

    Existing application code can keep using cursor.execute()/commit().  The
    first mutating statement owns the shared writer lane until commit,
    rollback, or close, preventing Flask and background threads from creating
    avoidable SQLite writer collisions.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._writer_owned = False
        self._writer_started_at = 0.0
        self._writer_kind = "UNKNOWN"
        self._writer_caller = "unknown"

    def cursor(self, factory=SerializedCursor):
        return super().cursor(factory)

    def _before_statement(self, sql):
        if not _is_write_statement(sql) or self._writer_owned:
            return
        global _ACTIVE_WRITER
        kind = _sql_kind(sql)
        with _META_LOCK:
            previous_writer = dict(_ACTIVE_WRITER) if _ACTIVE_WRITER else None
        wait_started = time.monotonic()
        _WRITE_LOCK.acquire()
        self._writer_owned = True
        self._writer_started_at = time.monotonic()
        self._writer_kind = kind
        self._writer_caller = _caller()
        with _META_LOCK:
            _ACTIVE_WRITER = {
                "thread": threading.current_thread().name,
                "kind": kind,
                "caller": self._writer_caller,
                "started_at": self._writer_started_at,
            }
        waited = self._writer_started_at - wait_started
        _metric("writes")
        if waited >= 0.10:
            wait_ms = int(waited * 1000)
            _metric("waits")
            _metric("max_wait_ms", wait_ms, maximum=True)
            _LOGGER.warning(
                "event=writer_wait wait_ms=%d kind=%s caller=%s previous=%r",
                wait_ms, kind, self._writer_caller, previous_writer,
            )

    def execute(self, sql, parameters=()):
        self._before_statement(sql)
        try:
            return super().execute(sql, parameters)
        except sqlite3.Error as error:
            _log_sql_error(sql, error)
            raise

    def executemany(self, sql, seq_of_parameters):
        self._before_statement(sql)
        try:
            return super().executemany(sql, seq_of_parameters)
        except sqlite3.Error as error:
            _log_sql_error(sql, error)
            raise

    def executescript(self, sql_script):
        self._before_statement(sql_script)
        try:
            return super().executescript(sql_script)
        except sqlite3.Error as error:
            _log_sql_error(sql_script, error)
            raise

    def _release_writer(self):
        global _ACTIVE_WRITER
        if not self._writer_owned:
            return
        held = time.monotonic() - self._writer_started_at
        self._writer_owned = False
        self._writer_started_at = 0.0
        with _META_LOCK:
            _ACTIVE_WRITER = None
        _WRITE_LOCK.release()
        if held >= 0.5:
            _metric("slow_transactions")
            _LOGGER.warning(
                "event=slow_transaction held_ms=%d kind=%s caller=%s",
                int(held * 1000), self._writer_kind, self._writer_caller,
            )

    def commit(self):
        try:
            return super().commit()
        finally:
            self._release_writer()

    def rollback(self):
        try:
            return super().rollback()
        finally:
            self._release_writer()

    def close(self):
        try:
            if self.in_transaction:
                super().rollback()
        finally:
            self._release_writer()
            super().close()

    def __exit__(self, exc_type, exc_value, traceback):
        # Preserve sqlite3's context-manager contract.  Some legacy routes
        # still use their cursor after the transaction block and close the
        # connection explicitly in ``finally``.
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False


def get_db_connection(timeout: float = DEFAULT_BUSY_TIMEOUT_SECONDS) -> sqlite3.Connection:
    """Open the local database with predictable concurrent-access settings."""
    global _STATE_LOGGED
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_FILE, timeout=timeout, factory=SerializedConnection)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(f"PRAGMA busy_timeout = {max(1, int(timeout * 1000))}")
    connection.execute("PRAGMA synchronous = NORMAL")
    should_log_state = False
    with _META_LOCK:
        if not _STATE_LOGGED:
            _STATE_LOGGED = True
            should_log_state = True
    if should_log_state:
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        locking_mode = connection.execute("PRAGMA locking_mode").fetchone()[0]
        _LOGGER.info(
            "event=database_state db=%s sqlite=%s journal_mode=%s locking_mode=%s "
            "busy_timeout_ms=%d",
            DB_FILE, sqlite3.sqlite_version, journal_mode, locking_mode,
            max(1, int(timeout * 1000)),
        )
    _metric("connections")
    return connection


def is_sqlite_busy_error(error: BaseException) -> bool:
    message = str(error).casefold()
    return "database is locked" in message or "database is busy" in message or "locked" in message


@contextmanager
def write_transaction(
    operation: str = "database write",
    *,
    timeout: float = 0.75,
    attempts: int = 8,
):
    """Run one short SQLite write transaction with bounded contention handling.

    The in-process lock prevents our Flask/background threads from racing each
    other. BEGIN IMMEDIATE makes cross-process contention happen before any
    data is changed, so retrying is safe and transactions stay short.
    """
    started_at = time.monotonic()
    with _WRITE_LOCK:
        connection = None
        for attempt in range(max(1, attempts)):
            connection = get_db_connection(timeout=timeout)
            try:
                connection.execute("BEGIN IMMEDIATE")
                break
            except sqlite3.OperationalError as error:
                connection.close()
                connection = None
                if not is_sqlite_busy_error(error):
                    _metric("errors")
                    _LOGGER.exception(
                        "event=begin_error operation=%r attempt=%d caller=%s",
                        operation, attempt + 1, _caller(),
                    )
                    raise
                _metric("busy_retries")
                _LOGGER.warning(
                    "event=busy_retry operation=%r attempt=%d/%d error=%r caller=%s",
                    operation, attempt + 1, max(1, attempts), str(error), _caller(),
                )
                if attempt + 1 >= max(1, attempts):
                    _metric("errors")
                    _LOGGER.error("SQLite write failed after retries: %s (%s)", operation, error)
                    raise
                time.sleep(min(0.04 * (attempt + 1), 0.20) + random.uniform(0.0, 0.015))
        try:
            yield connection
            connection.commit()
            elapsed = time.monotonic() - started_at
            if elapsed >= 0.5:
                _LOGGER.warning("SQLite write waited %.3fs: %s", elapsed, operation)
        except Exception:
            _metric("errors")
            _LOGGER.exception("event=transaction_error operation=%r caller=%s", operation, _caller())
            connection.rollback()
            raise
        finally:
            connection.close()


_LOGGER.info(
    "event=diagnostics_started db=%s busy_timeout_ms=%d",
    DB_FILE, DEFAULT_BUSY_TIMEOUT_SECONDS * 1000,
)
