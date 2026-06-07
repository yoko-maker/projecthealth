"""安全配慮ガードのテスト（仕様書 18章）。
一時停止中の走査抑制・メトリクス数上限・データ削除の完全性を検証する。
"""
import sqlite3
import pytest
from app.models import init_db, get_conn
from app.safety import (
    is_paused, can_add_metric, active_metric_count,
    check_severe_symptoms, scan_should_run, MAX_METRICS,
)


@pytest.fixture
def conn():
    """テスト用インメモリDB。"""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.executescript("""
        CREATE TABLE metrics (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            dtype TEXT NOT NULL,
            created_at TEXT NOT NULL,
            archived INTEGER DEFAULT 0
        );
        CREATE TABLE entries (
            id INTEGER PRIMARY KEY,
            date TEXT NOT NULL,
            metric_id INTEGER NOT NULL REFERENCES metrics(id),
            value REAL,
            UNIQUE(date, metric_id)
        );
        CREATE TABLE settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            sensitivity TEXT DEFAULT 'conservative',
            notify_time TEXT DEFAULT '21:00',
            paused INTEGER DEFAULT 0,
            onboarded INTEGER DEFAULT 0,
            last_scan TEXT
        );
        INSERT INTO settings(id) VALUES(1);
    """)
    return c


class TestPause:
    def test_not_paused_by_default(self, conn):
        assert is_paused(conn) is False

    def test_paused_returns_true(self, conn):
        conn.execute("UPDATE settings SET paused=1 WHERE id=1")
        assert is_paused(conn) is True

    def test_scan_blocked_when_paused(self, conn):
        conn.execute("UPDATE settings SET paused=1 WHERE id=1")
        assert scan_should_run(conn, "2025-01-01") is False

    def test_scan_runs_when_not_paused(self, conn):
        assert scan_should_run(conn, "2025-01-01") is True

    def test_scan_skipped_same_day(self, conn):
        conn.execute("UPDATE settings SET last_scan='2025-01-01' WHERE id=1")
        assert scan_should_run(conn, "2025-01-01") is False

    def test_scan_runs_new_day(self, conn):
        conn.execute("UPDATE settings SET last_scan='2025-01-01' WHERE id=1")
        assert scan_should_run(conn, "2025-01-02") is True


class TestMetricLimit:
    def test_can_add_when_empty(self, conn):
        assert can_add_metric(conn) is True

    def test_cannot_add_at_limit(self, conn):
        for i in range(MAX_METRICS):
            conn.execute(
                "INSERT INTO metrics (name, role, dtype, created_at) VALUES (?, 'symptom', 'binary', '2025-01-01')",
                (f"metric_{i}",)
            )
        assert can_add_metric(conn) is False
        assert active_metric_count(conn) == MAX_METRICS

    def test_archived_not_counted(self, conn):
        conn.execute(
            "INSERT INTO metrics (name, role, dtype, created_at, archived) VALUES ('archived', 'symptom', 'binary', '2025-01-01', 1)"
        )
        assert active_metric_count(conn) == 0
        assert can_add_metric(conn) is True


class TestSevereSymptoms:
    def _add_metric(self, conn):
        conn.execute(
            "INSERT INTO metrics (id, name, role, dtype, created_at) VALUES (1, 'テスト症状', 'symptom', 'binary', '2025-01-01')"
        )

    def test_no_warning_with_few_days(self, conn):
        self._add_metric(conn)
        # 3日しか記録がない（閾値7日未満）
        for i, val in enumerate([1, 1, 1]):
            conn.execute(
                "INSERT INTO entries (date, metric_id, value) VALUES (?, 1, ?)",
                (f"2025-01-0{i+1}", val)
            )
        assert check_severe_symptoms(conn, 1, consecutive_days=7) is False

    def test_warning_with_continuous_symptom(self, conn):
        self._add_metric(conn)
        for i in range(7):
            conn.execute(
                "INSERT INTO entries (date, metric_id, value) VALUES (?, 1, 1)",
                (f"2025-01-{i+1:02d}",)
            )
        assert check_severe_symptoms(conn, 1, consecutive_days=7) is True

    def test_no_warning_with_mixed(self, conn):
        self._add_metric(conn)
        vals = [1, 1, 1, 0, 1, 1, 1]  # 途中でなし
        for i, v in enumerate(vals):
            conn.execute(
                "INSERT INTO entries (date, metric_id, value) VALUES (?, 1, ?)",
                (f"2025-01-{i+1:02d}", v)
            )
        assert check_severe_symptoms(conn, 1, consecutive_days=7) is False
