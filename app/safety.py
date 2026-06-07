"""安全配慮ガード（仕様書 3章 SAFE-1〜7）。
本モジュールは機能要件に優先する。迷ったら控えめ側に倒す。
"""
from __future__ import annotations

import sqlite3

MAX_METRICS = 6  # SAFE-1: 項目数上限

ONBOARDING_TEXT = (
    "このツールについて\n\n"
    "● 本ツールは医療機器でも診断ツールでもなく、医療の代替にはなりません。\n"
    "  気になる症状は、専門家（医師・医療機関）にご相談ください。\n\n"
    "● 記録が負担に感じたら、いつでも中断してかまいません。\n"
    "  記録をやめたほうが体調がよくなる場合もあります。\n\n"
    "● 本ツールが見つけた「関連」は、原因ではありません。\n"
    "  あくまで参考として、穏やかに受け取ってください。\n\n"
    "記録項目は3〜4個を推奨します（上限6個）。\n"
    "少ない項目で始めることをおすすめします。"
)

METRIC_LIMIT_WARNING = (
    f"記録項目が{MAX_METRICS}件に達しています。"
    "項目が多いと記録の負担が増えます（SAFE-1）。"
    "追加する場合は、既存の項目のアーカイブをご検討ください。"
)

SEVERE_SYMPTOM_MESSAGE = (
    "最近、強いつらさが続いているようです。"
    "体調が心配な場合は、医療機関への相談をご検討ください。"
    "本ツールの記録を中断することも、いつでもできます（設定→一時停止）。"
)


def is_paused(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT paused FROM settings WHERE id=1").fetchone()
    return bool(row["paused"]) if row else False


def active_metric_count(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM metrics WHERE archived=0"
    ).fetchone()
    return row["n"] if row else 0


def can_add_metric(conn: sqlite3.Connection) -> bool:
    return active_metric_count(conn) < MAX_METRICS


def check_severe_symptoms(
    conn: sqlite3.Connection, symptom_id: int, consecutive_days: int = 7
) -> bool:
    """直近N日連続で症状ありなら True（SAFE-7用）。"""
    rows = conn.execute("""
        SELECT value FROM entries
        WHERE metric_id=?
        ORDER BY date DESC
        LIMIT ?
    """, (symptom_id, consecutive_days)).fetchall()
    if len(rows) < consecutive_days:
        return False
    return all(r["value"] == 1 for r in rows)


def scan_should_run(conn: sqlite3.Connection, today: str) -> bool:
    """一時停止中・本日済みは走査しない（SAFE-6）。"""
    if is_paused(conn):
        return False
    row = conn.execute("SELECT last_scan FROM settings WHERE id=1").fetchone()
    last = row["last_scan"] if row else None
    return last != today
