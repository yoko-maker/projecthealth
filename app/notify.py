"""通知判定（仕様書 14章）。
サーバープッシュは行わない。PWA側のローカル通知をサポートするための判定のみ。
"""
from __future__ import annotations

import sqlite3
from datetime import date

from app.safety import is_paused


def should_remind_today(conn: sqlite3.Connection) -> bool:
    """本日の記録リマインドを送るべきか（一時停止中・記録済みは False）。"""
    if is_paused(conn):
        return False
    today = date.today().isoformat()
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM entries WHERE date=?", (today,)
    ).fetchone()
    return row["n"] == 0


def get_notify_time(conn: sqlite3.Connection) -> str:
    """設定されたリマインド時刻を返す（既定 21:00）。"""
    row = conn.execute("SELECT notify_time FROM settings WHERE id=1").fetchone()
    return row["notify_time"] if row else "21:00"
