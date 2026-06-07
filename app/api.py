"""REST APIルーティング（仕様書 12章）。
ローカル前提のためv1は認証省略。健康データは外部送信しない（SAFE）。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.models import get_conn
from app.correlate import run_full_scan
from app.verbalize import (
    build_text,
    build_experiment_proposal,
    build_experiment_conclusion,
)
from app.safety import (
    is_paused,
    can_add_metric,
    active_metric_count,
    check_severe_symptoms,
    ONBOARDING_TEXT,
    METRIC_LIMIT_WARNING,
    SEVERE_SYMPTOM_MESSAGE,
    MAX_METRICS,
)
from app.scheduler import run_daily_scan, ensure_auto_factors
from app.notify import should_remind_today, get_notify_time

router = APIRouter(prefix="/api")


def _db():
    conn = get_conn()
    try:
        yield conn
    finally:
        conn.close()


# ── 記録項目 (metrics) ──────────────────────────────────────────────────────


class MetricCreate(BaseModel):
    name: str
    role: str   # 'symptom' | 'factor'
    dtype: str  # 'binary' | 'continuous' | 'category'


class MetricPatch(BaseModel):
    name: str | None = None
    archived: int | None = None


@router.get("/metrics")
def list_metrics(conn: sqlite3.Connection = Depends(_db)):
    rows = conn.execute(
        "SELECT * FROM metrics WHERE archived=0 ORDER BY role, id"
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/metrics", status_code=201)
def create_metric(body: MetricCreate, conn: sqlite3.Connection = Depends(_db)):
    if not can_add_metric(conn):
        return JSONResponse(
            status_code=422,
            content={"detail": METRIC_LIMIT_WARNING, "code": "limit_exceeded"},
        )
    if body.role not in ("symptom", "factor"):
        raise HTTPException(400, "role は 'symptom' か 'factor' を指定してください")
    if body.dtype not in ("binary", "continuous", "category"):
        raise HTTPException(400, "dtype は binary/continuous/category を指定してください")
    cur = conn.execute(
        "INSERT INTO metrics (name, role, dtype, created_at) VALUES (?, ?, ?, ?)",
        (body.name, body.role, body.dtype, datetime.now().isoformat()),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM metrics WHERE id=?", (cur.lastrowid,)).fetchone())


@router.patch("/metrics/{metric_id}")
def update_metric(
    metric_id: int,
    body: MetricPatch,
    conn: sqlite3.Connection = Depends(_db),
):
    row = conn.execute("SELECT * FROM metrics WHERE id=?", (metric_id,)).fetchone()
    if not row:
        raise HTTPException(404, "metric not found")
    updates, params = [], []
    if body.name is not None:
        updates.append("name=?"); params.append(body.name)
    if body.archived is not None:
        updates.append("archived=?"); params.append(body.archived)
    if updates:
        params.append(metric_id)
        conn.execute(f"UPDATE metrics SET {','.join(updates)} WHERE id=?", params)
        conn.commit()
    return dict(conn.execute("SELECT * FROM metrics WHERE id=?", (metric_id,)).fetchone())


# ── 日次記録 (entries) ──────────────────────────────────────────────────────


class EntryItem(BaseModel):
    metric_id: int
    value: float | None


class EntriesBody(BaseModel):
    date: str | None = None
    entries: list[EntryItem]


@router.get("/today")
def get_today_form(conn: sqlite3.Connection = Depends(_db)):
    today = date.today().isoformat()
    metrics = conn.execute(
        "SELECT * FROM metrics WHERE archived=0 ORDER BY role, id"
    ).fetchall()
    existing = {
        r["metric_id"]: r["value"]
        for r in conn.execute(
            "SELECT metric_id, value FROM entries WHERE date=?", (today,)
        ).fetchall()
    }
    paused = is_paused(conn)

    # 直近の症状に対してSAFE-7チェック
    severe_warnings = []
    for m in metrics:
        if m["role"] == "symptom" and m["dtype"] == "binary":
            if check_severe_symptoms(conn, m["id"]):
                severe_warnings.append(m["name"])

    return {
        "date": today,
        "paused": paused,
        "metrics": [dict(m) for m in metrics],
        "existing_values": existing,
        "severe_warning": SEVERE_SYMPTOM_MESSAGE if severe_warnings else None,
        "remind_today": should_remind_today(conn),
        "notify_time": get_notify_time(conn),
    }


@router.post("/entries", status_code=201)
def save_entries(body: EntriesBody, conn: sqlite3.Connection = Depends(_db)):
    if is_paused(conn):
        raise HTTPException(403, "記録は一時停止中です（設定から再開できます）")
    target_date = body.date or date.today().isoformat()
    for item in body.entries:
        conn.execute("""
            INSERT INTO entries (date, metric_id, value)
            VALUES (?, ?, ?)
            ON CONFLICT(date, metric_id) DO UPDATE SET value=excluded.value
        """, (target_date, item.metric_id, item.value))
    weekday = date.fromisoformat(target_date).weekday()
    conn.execute(
        "INSERT OR IGNORE INTO auto_factors (date, weekday) VALUES (?, ?)",
        (target_date, weekday),
    )
    conn.commit()
    return {"date": target_date, "saved": len(body.entries)}


@router.patch("/entries")
def update_entries(body: EntriesBody, conn: sqlite3.Connection = Depends(_db)):
    if not body.date:
        raise HTTPException(400, "過去日修正には date フィールドが必要です")
    return save_entries(body, conn)


# ── 気づき (insights) ───────────────────────────────────────────────────────


@router.get("/insights")
def get_insights(conn: sqlite3.Connection = Depends(_db)):
    rows = conn.execute("""
        SELECT i.*, m.name AS symptom_name
        FROM insights i
        JOIN metrics m ON m.id = i.symptom_id
        WHERE i.dismissed=0
        ORDER BY ABS(i.effect) DESC
        LIMIT 2
    """).fetchall()

    result = []
    for r in rows:
        parts = r["text"].split("\n", 1)
        body_text = parts[0]
        disclaimer = parts[1] if len(parts) > 1 else ""
        has_exp = conn.execute(
            "SELECT COUNT(*) AS n FROM experiments WHERE insight_id=?", (r["id"],)
        ).fetchone()["n"] > 0
        result.append({
            "id": r["id"],
            "text": body_text,
            "disclaimer": disclaimer,
            "strength": r["strength"],
            "can_experiment": not has_exp,
        })

    if not result:
        return []
    return result


@router.post("/insights/{insight_id}/dismiss")
def dismiss_insight(insight_id: int, conn: sqlite3.Connection = Depends(_db)):
    if not conn.execute("SELECT id FROM insights WHERE id=?", (insight_id,)).fetchone():
        raise HTTPException(404)
    conn.execute("UPDATE insights SET dismissed=1 WHERE id=?", (insight_id,))
    conn.commit()
    return {"dismissed": True}


@router.post("/insights/{insight_id}/experiment", status_code=201)
def start_experiment(insight_id: int, conn: sqlite3.Connection = Depends(_db)):
    row = conn.execute("""
        SELECT i.*, m.name AS factor_name
        FROM insights i
        LEFT JOIN metrics m ON m.id = CAST(i.factor_ref AS INTEGER)
        WHERE i.id=?
    """, (insight_id,)).fetchone()
    if not row:
        raise HTTPException(404)

    today = date.today().isoformat()
    before_entries = conn.execute("""
        SELECT value FROM entries
        WHERE metric_id=? AND date < ?
        ORDER BY date DESC
        LIMIT 14
    """, (row["symptom_id"], today)).fetchall()
    before_vals = [e["value"] for e in before_entries if e["value"] is not None]
    before_rate = sum(before_vals) / len(before_vals) if before_vals else 0.0

    factor_name = row["factor_name"] or row["factor_ref"]
    intervention = build_experiment_proposal(factor_name, row["effect"] > 0)

    cur = conn.execute("""
        INSERT INTO experiments (insight_id, start_date, intervention, before_rate)
        VALUES (?, ?, ?, ?)
    """, (insight_id, today, intervention, before_rate))
    conn.commit()
    return {"id": cur.lastrowid, "intervention": intervention, "start_date": today}


# ── 検証実験 (experiments) ──────────────────────────────────────────────────


@router.get("/experiments")
def list_experiments(conn: sqlite3.Connection = Depends(_db)):
    rows = conn.execute("""
        SELECT e.*, i.text AS insight_text, i.symptom_id
        FROM experiments e JOIN insights i ON i.id = e.insight_id
        ORDER BY e.id DESC
    """).fetchall()

    result = []
    for r in rows:
        item = dict(r)
        if item["end_date"] is None and item["start_date"]:
            start = date.fromisoformat(item["start_date"])
            if (date.today() - start).days >= 3:
                after_entries = conn.execute("""
                    SELECT value FROM entries
                    WHERE metric_id=? AND date >= ? AND date <= ?
                """, (r["symptom_id"], item["start_date"],
                      date.today().isoformat())).fetchall()
                after_vals = [e["value"] for e in after_entries if e["value"] is not None]
                after_rate = sum(after_vals) / len(after_vals) if after_vals else 0.0
                conclusion = build_experiment_conclusion(
                    item["before_rate"] or 0.0, after_rate
                )
                conn.execute("""
                    UPDATE experiments
                    SET end_date=?, after_rate=?, conclusion=? WHERE id=?
                """, (date.today().isoformat(), after_rate, conclusion, r["id"]))
                conn.commit()
                item.update(end_date=date.today().isoformat(),
                            after_rate=after_rate, conclusion=conclusion)
        result.append(item)
    return result


# ── 設定 (settings) ─────────────────────────────────────────────────────────


class SettingsPatch(BaseModel):
    sensitivity: str | None = None
    notify_time: str | None = None
    paused: int | None = None
    onboarded: int | None = None


@router.get("/settings")
def get_settings(conn: sqlite3.Connection = Depends(_db)):
    row = conn.execute("SELECT * FROM settings WHERE id=1").fetchone()
    s = dict(row)
    s["onboarding_text"] = ONBOARDING_TEXT
    s["max_metrics"] = MAX_METRICS
    s["active_metric_count"] = active_metric_count(conn)
    return s


@router.patch("/settings")
def update_settings(body: SettingsPatch, conn: sqlite3.Connection = Depends(_db)):
    updates, params = [], []
    if body.sensitivity in ("conservative", "standard"):
        updates.append("sensitivity=?"); params.append(body.sensitivity)
    if body.notify_time is not None:
        updates.append("notify_time=?"); params.append(body.notify_time)
    if body.paused is not None:
        updates.append("paused=?"); params.append(body.paused)
    if body.onboarded is not None:
        updates.append("onboarded=?"); params.append(body.onboarded)
    if updates:
        params.append(1)
        conn.execute(f"UPDATE settings SET {','.join(updates)} WHERE id=?", params)
        conn.commit()
    return get_settings(conn)


@router.post("/pause")
def toggle_pause(conn: sqlite3.Connection = Depends(_db)):
    current = is_paused(conn)
    conn.execute("UPDATE settings SET paused=? WHERE id=1", (0 if current else 1,))
    conn.commit()
    return {"paused": not current}


# ── データ管理 ──────────────────────────────────────────────────────────────


@router.get("/export")
def export_data(conn: sqlite3.Connection = Depends(_db)):
    data: dict[str, Any] = {
        "metrics":      [dict(r) for r in conn.execute("SELECT * FROM metrics").fetchall()],
        "entries":      [dict(r) for r in conn.execute("SELECT * FROM entries").fetchall()],
        "auto_factors": [dict(r) for r in conn.execute("SELECT * FROM auto_factors").fetchall()],
        "experiments":  [dict(r) for r in conn.execute("SELECT * FROM experiments").fetchall()],
        "settings":     dict(conn.execute("SELECT * FROM settings WHERE id=1").fetchone()),
        "exported_at":  datetime.now().isoformat(),
    }
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": "attachment; filename=health_export.json"},
    )


class ImportBody(BaseModel):
    data: dict


@router.post("/import")
def import_data(body: ImportBody, conn: sqlite3.Connection = Depends(_db)):
    d = body.data
    for m in d.get("metrics", []):
        conn.execute("""
            INSERT OR REPLACE INTO metrics (id, name, role, dtype, created_at, archived)
            VALUES (:id, :name, :role, :dtype, :created_at, :archived)
        """, m)
    for e in d.get("entries", []):
        conn.execute("""
            INSERT OR REPLACE INTO entries (id, date, metric_id, value)
            VALUES (:id, :date, :metric_id, :value)
        """, e)
    for a in d.get("auto_factors", []):
        conn.execute("""
            INSERT OR REPLACE INTO auto_factors (date, weekday, weather, pressure_hpa)
            VALUES (:date, :weekday, :weather, :pressure_hpa)
        """, a)
    conn.commit()
    return {"imported": True}


@router.delete("/data")
def delete_all_data(confirm: bool = False, conn: sqlite3.Connection = Depends(_db)):
    if not confirm:
        raise HTTPException(
            400, "全データ削除には ?confirm=true が必要です"
        )
    for table in ("experiments", "insights", "entries", "auto_factors", "metrics"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute(
        "UPDATE settings SET onboarded=0, last_scan=NULL, paused=0 WHERE id=1"
    )
    conn.commit()
    return {"deleted": True}


@router.post("/recompute")
def recompute(conn: sqlite3.Connection = Depends(_db)):
    """相関を即時再走査する（last_scanをリセットして強制実行）。"""
    conn.execute("UPDATE settings SET last_scan=NULL WHERE id=1")
    conn.commit()
    n = run_daily_scan(conn)
    return {"insights_generated": n}
