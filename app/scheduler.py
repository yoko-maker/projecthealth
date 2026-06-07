"""日次バッチ処理（仕様書 11章）。
起動時にバックグラウンドスレッドで1回実行し、以降は日を越えた初回APIアクセス時に再実行する。
"""
from __future__ import annotations

import threading
from datetime import date, datetime

import sqlite3

from app.models import get_conn
from app.correlate import run_full_scan
from app.verbalize import build_text
from app.safety import scan_should_run


def ensure_auto_factors(conn: sqlite3.Connection) -> None:
    """当日の自動要因（曜日）を記録する（FR-3.1）。"""
    today = date.today().isoformat()
    weekday = date.today().weekday()  # 0=月〜6=日
    conn.execute(
        "INSERT OR IGNORE INTO auto_factors (date, weekday) VALUES (?, ?)",
        (today, weekday),
    )
    conn.commit()


def run_daily_scan(conn: sqlite3.Connection | None = None) -> int:
    """相関走査を実行し、新しいInsightをDBに保存する。
    Returns: 生成されたInsight数（0 = 気づきなし = 正常）。
    """
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        today = date.today().isoformat()
        if not scan_should_run(conn, today):
            return 0

        row = conn.execute("SELECT sensitivity FROM settings WHERE id=1").fetchone()
        sensitivity = row["sensitivity"] if row else "conservative"

        results = run_full_scan(conn, sensitivity)

        # 非表示にしていない既存Insightを削除して再生成（派生データ: 仕様書 10章）
        conn.execute("DELETE FROM insights WHERE dismissed=0")

        inserted = 0
        for r in results:
            _, full_text = build_text(
                r["symptom_name"], r["factor_name"],
                r["lag"], r["direction_positive"],
                r["strength"], r["factor_dtype"],
            )
            conn.execute("""
                INSERT INTO insights
                  (symptom_id, factor_ref, lag, effect, strength, text, detected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                r["symptom_id"], r["factor_ref"], r["lag"],
                r["effect"], r["strength"], full_text,
                datetime.now().isoformat(),
            ))
            inserted += 1

        conn.execute("UPDATE settings SET last_scan=? WHERE id=1", (today,))
        conn.commit()
        return inserted
    finally:
        if own_conn:
            conn.close()


def start_background_scheduler() -> None:
    """起動時に1回だけバックグラウンドで自動要因記録と走査を行う。"""
    def _worker() -> None:
        try:
            with get_conn() as conn:
                ensure_auto_factors(conn)
            run_daily_scan()
        except Exception:
            pass  # バックグラウンドエラーはサイレントに

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
