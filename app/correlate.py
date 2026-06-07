"""相関発見エンジン（仕様書 8章）。
重いMLは使わず、標準化平均差・リフト値・順位相関のみを用いる。
解釈可能性を最優先にし、偽発見を恐れる側に倒す。
"""
from __future__ import annotations

import sqlite3
from statistics import mean, pstdev
from typing import Any


# ── 統計プリミティブ ────────────────────────────────────────────────────────


def cohens_d(group_a: list[float], group_b: list[float]) -> float | None:
    """二群の標準化平均差（Cohen's d）。データ不足時はNone。"""
    if len(group_a) < 2 or len(group_b) < 2:
        return None
    na, nb = len(group_a), len(group_b)
    va = pstdev(group_a) ** 2
    vb = pstdev(group_b) ** 2
    pooled_var = ((na - 1) * va + (nb - 1) * vb) / (na + nb - 2)
    if pooled_var <= 0:
        return None
    return (mean(group_a) - mean(group_b)) / pooled_var ** 0.5


def lift_value(n_11: int, n_10: int, n_01: int, n_00: int) -> float | None:
    """リフト値: P(症状∩要因) / (P(症状)×P(要因))。"""
    total = n_11 + n_10 + n_01 + n_00
    if total == 0:
        return None
    p_sym = (n_11 + n_10) / total
    p_fac = (n_11 + n_01) / total
    denom = p_sym * p_fac
    if denom == 0:
        return None
    return (n_11 / total) / denom


def _rank_data(data: list[float]) -> list[float]:
    """タイの平均順位を使った順位変換。"""
    n = len(data)
    sorted_idx = sorted(range(n), key=lambda i: data[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j < n - 1 and data[sorted_idx[j + 1]] == data[sorted_idx[i]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[sorted_idx[k]] = avg_rank
        i = j + 1
    return ranks


def spearman_rho(xs: list[float], ys: list[float]) -> float | None:
    """Spearman順位相関係数。n<4時はNone。"""
    n = len(xs)
    if n < 4:
        return None
    rx = _rank_data(xs)
    ry = _rank_data(ys)
    d2 = sum((a - b) ** 2 for a, b in zip(rx, ry))
    denom = n * (n ** 2 - 1)
    if denom == 0:
        return None
    return 1 - 6 * d2 / denom


# ── 閾値設定 ────────────────────────────────────────────────────────────────

THRESHOLDS: dict[str, dict[str, Any]] = {
    "conservative": {"n_min": 5, "d_min": 0.5, "lift_min": 1.5, "min_days": 14},
    "standard":     {"n_min": 4, "d_min": 0.4, "lift_min": 1.3, "min_days": 14},
}

# 効果量 → 強さ表現の写像（仕様書 8.6）
_STRENGTH_LEVELS = [
    (0.8, 2.0, "clear"),
    (0.5, 1.5, "mild"),
]


def _effect_to_strength(d: float | None, lft: float | None) -> str | None:
    abs_d = abs(d) if d is not None else 0.0
    lft_v = lft if lft is not None else 0.0
    for d_thr, l_thr, label in _STRENGTH_LEVELS:
        if abs_d >= d_thr or lft_v >= l_thr:
            return label
    return None


# ── ペア評価 ────────────────────────────────────────────────────────────────


def _evaluate_pair(
    sym_vals: list[Any],
    fac_vals: list[Any],
    sym_dtype: str,
    fac_dtype: str,
    cfg: dict[str, Any],
) -> dict | None:
    """(症状, 要因) ペアの1ラグ分を評価。足切り未満はNone。"""
    n_min = cfg["n_min"]
    d_min = cfg["d_min"]
    lift_min = cfg["lift_min"]

    if sym_dtype == "binary" and fac_dtype == "continuous":
        with_s  = [f for s, f in zip(sym_vals, fac_vals) if s == 1]
        without = [f for s, f in zip(sym_vals, fac_vals) if s == 0]
        if len(with_s) < n_min or len(without) < n_min:
            return None
        d = cohens_d(with_s, without)
        if d is None or abs(d) < d_min:
            return None
        strength = _effect_to_strength(d, None)
        if not strength:
            return None
        return {
            "effect": d, "effect_type": "cohens_d", "strength": strength,
            "direction_positive": d > 0,
            "n_pos": len(with_s), "n_neg": len(without),
        }

    elif sym_dtype == "binary" and fac_dtype in ("binary", "category"):
        n_11 = sum(1 for s, f in zip(sym_vals, fac_vals) if s == 1 and f == 1)
        n_10 = sum(1 for s, f in zip(sym_vals, fac_vals) if s == 1 and f == 0)
        n_01 = sum(1 for s, f in zip(sym_vals, fac_vals) if s == 0 and f == 1)
        n_00 = sum(1 for s, f in zip(sym_vals, fac_vals) if s == 0 and f == 0)
        if n_11 < n_min or (n_10 + n_00) < n_min:
            return None
        lft = lift_value(n_11, n_10, n_01, n_00)
        if lft is None or lft < lift_min:
            return None
        strength = _effect_to_strength(None, lft)
        if not strength:
            return None
        return {
            "effect": lft, "effect_type": "lift", "strength": strength,
            "direction_positive": True,
            "n_pos": n_11, "n_neg": n_10 + n_00,
        }

    elif sym_dtype == "continuous" and fac_dtype == "continuous":
        if len(sym_vals) < 4:
            return None
        rho = spearman_rho(list(sym_vals), list(fac_vals))
        if rho is None or abs(rho) < d_min:
            return None
        strength = _effect_to_strength(rho, None)
        if not strength:
            return None
        return {
            "effect": rho, "effect_type": "spearman", "strength": strength,
            "direction_positive": rho > 0,
            "n_pos": len(sym_vals), "n_neg": 0,
        }

    elif sym_dtype == "continuous" and fac_dtype in ("binary", "category"):
        g1 = [s for s, f in zip(sym_vals, fac_vals) if f == 1]
        g0 = [s for s, f in zip(sym_vals, fac_vals) if f == 0]
        if len(g1) < n_min or len(g0) < n_min:
            return None
        d = cohens_d(g1, g0)
        if d is None or abs(d) < d_min:
            return None
        strength = _effect_to_strength(d, None)
        if not strength:
            return None
        return {
            "effect": d, "effect_type": "cohens_d", "strength": strength,
            "direction_positive": d > 0,
            "n_pos": len(g1), "n_neg": len(g0),
        }

    return None


# ── メインスキャン関数 ──────────────────────────────────────────────────────


def scan(
    daily_rows: list[dict],
    symptom: str,
    factor: str,
    sym_dtype: str,
    fac_dtype: str,
    cfg: dict[str, Any],
    lags: tuple[int, ...] = (0, 1, 2),
) -> dict | None:
    """症状×要因の関連を複数ラグで評価し、最良ラグの結果を返す。
    足切り未満なら None（= 気づきなし = 正常）。
    """
    best: dict | None = None
    for lag in lags:
        sym_vals: list[Any] = []
        fac_vals: list[Any] = []
        for i in range(lag, len(daily_rows)):
            s = daily_rows[i].get(symptom)
            f = daily_rows[i - lag].get(factor)
            if s is None or f is None:
                continue
            sym_vals.append(s)
            fac_vals.append(f)

        result = _evaluate_pair(sym_vals, fac_vals, sym_dtype, fac_dtype, cfg)
        if result is None:
            continue
        if best is None or abs(result["effect"]) > abs(best["effect"]):
            best = {**result, "lag": lag}
    return best


def run_full_scan(
    conn: sqlite3.Connection,
    sensitivity: str = "conservative",
) -> list[dict]:
    """全症状×全要因ペアを走査し、気づき候補を最大2件返す。
    閾値未満のものはすべて無視する（沈黙が正常）。
    """
    cfg = THRESHOLDS[sensitivity]

    row = conn.execute(
        "SELECT COUNT(DISTINCT date) AS n FROM entries"
    ).fetchone()
    if row["n"] < cfg["min_days"]:
        return []

    metrics = conn.execute(
        "SELECT * FROM metrics WHERE archived=0"
    ).fetchall()
    symptoms = [m for m in metrics if m["role"] == "symptom"]
    factors  = [m for m in metrics if m["role"] == "factor"]
    if not symptoms or not factors:
        return []

    # 日付→値の辞書リストを構築
    entries_rows = conn.execute("""
        SELECT e.date, e.metric_id, e.value, m.dtype
        FROM entries e JOIN metrics m ON m.id = e.metric_id
        ORDER BY e.date
    """).fetchall()
    auto_rows = conn.execute(
        "SELECT date, weekday FROM auto_factors ORDER BY date"
    ).fetchall()

    daily: dict[str, dict] = {}
    for e in entries_rows:
        d = e["date"]
        if d not in daily:
            daily[d] = {}
        daily[d][f"m_{e['metric_id']}"] = e["value"]
    for a in auto_rows:
        d = a["date"]
        if d not in daily:
            daily[d] = {}
        daily[d]["auto_weekday"] = float(a["weekday"])

    daily_list = [daily[d] for d in sorted(daily.keys())]

    results: list[dict] = []
    for sym in symptoms:
        sym_key = f"m_{sym['id']}"
        for fac in factors:
            fac_key = f"m_{fac['id']}"
            r = scan(daily_list, sym_key, fac_key,
                     sym["dtype"], fac["dtype"], cfg)
            if r:
                results.append({
                    "symptom_id": sym["id"],
                    "symptom_name": sym["name"],
                    "factor_ref": str(fac["id"]),
                    "factor_name": fac["name"],
                    "factor_dtype": fac["dtype"],
                    "sym_dtype": sym["dtype"],
                    **r,
                })

        # 曜日（自動要因）との関連も評価
        r = scan(daily_list, sym_key, "auto_weekday",
                 sym["dtype"], "continuous", cfg)
        if r:
            results.append({
                "symptom_id": sym["id"],
                "symptom_name": sym["name"],
                "factor_ref": "auto_weekday",
                "factor_name": "曜日",
                "factor_dtype": "continuous",
                "sym_dtype": sym["dtype"],
                **r,
            })

    # 効果量上位2件のみ（FR-5.4）
    results.sort(key=lambda x: abs(x["effect"]), reverse=True)
    return results[:2]
