"""SQLiteデータベース層。すべてローカル保存。健康データは外部送信しない。"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

_default_db = Path(__file__).parent.parent / "data" / "health.db"
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(_default_db)))


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS metrics (
                id         INTEGER PRIMARY KEY,
                name       TEXT    NOT NULL,
                role       TEXT    NOT NULL CHECK(role IN ('symptom','factor')),
                dtype      TEXT    NOT NULL CHECK(dtype IN ('binary','continuous','category')),
                created_at TEXT    NOT NULL,
                archived   INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS entries (
                id        INTEGER PRIMARY KEY,
                date      TEXT    NOT NULL,
                metric_id INTEGER NOT NULL REFERENCES metrics(id),
                value     REAL,
                UNIQUE(date, metric_id)
            );

            CREATE TABLE IF NOT EXISTS auto_factors (
                date         TEXT PRIMARY KEY,
                weekday      INTEGER,
                weather      TEXT,
                pressure_hpa REAL
            );

            CREATE TABLE IF NOT EXISTS insights (
                id          INTEGER PRIMARY KEY,
                symptom_id  INTEGER NOT NULL REFERENCES metrics(id),
                factor_ref  TEXT    NOT NULL,
                lag         INTEGER NOT NULL,
                effect      REAL    NOT NULL,
                strength    TEXT    NOT NULL CHECK(strength IN ('clear','mild')),
                text        TEXT    NOT NULL,
                detected_at TEXT    NOT NULL,
                dismissed   INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS experiments (
                id           INTEGER PRIMARY KEY,
                insight_id   INTEGER NOT NULL REFERENCES insights(id),
                start_date   TEXT    NOT NULL,
                end_date     TEXT,
                intervention TEXT    NOT NULL,
                before_rate  REAL,
                after_rate   REAL,
                conclusion   TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                id          INTEGER PRIMARY KEY CHECK(id = 1),
                sensitivity TEXT    DEFAULT 'conservative',
                notify_time TEXT    DEFAULT '21:00',
                paused      INTEGER DEFAULT 0,
                onboarded   INTEGER DEFAULT 0,
                last_scan   TEXT
            );

            INSERT OR IGNORE INTO settings(id) VALUES(1);
        """)
