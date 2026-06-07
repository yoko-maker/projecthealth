"""言語化モジュール（仕様書 9章）。
統計結果を生活言語の仮説文に変換し、禁止語チェックを内蔵する。
すべての出力に「原因とは限らない」免責文を必ず付与する（SAFE-3）。
"""
from __future__ import annotations

# 禁止語リスト（SAFE-2/3/4準拠）
FORBIDDEN_WORDS = [
    "原因です", "が原因", "やめましょう", "やめてください",
    "危険", "悪化し続ける", "悪化する", "絶対に",
    "確実に", "診断", "治療", "薬",
]

DISCLAIMER = "※これは関連であって、原因とは限りません。"

_LAG_PREFIX = {0: "", 1: "前日の", 2: "一昨日の"}
_STRENGTH_LABEL = {"clear": "はっきり", "mild": "ややあり"}


def _direction_word(positive: bool, fac_dtype: str) -> str:
    if fac_dtype in ("binary", "category"):
        return "ある日が多め" if positive else "ない日が多め"
    return "多め" if positive else "少なめ"


def build_text(
    symptom_name: str,
    factor_name: str,
    lag: int,
    direction_positive: bool,
    strength: str,
    factor_dtype: str,
) -> tuple[str, str]:
    """仮説文を生成する。
    Returns:
        (本文, 本文＋免責文の結合テキスト)
    """
    lag_str = _LAG_PREFIX.get(lag, "")
    strength_str = _STRENGTH_LABEL[strength]
    dir_word = _direction_word(direction_positive, factor_dtype)

    if factor_dtype in ("binary", "category"):
        body = (
            f"{symptom_name}が出た日は、"
            f"{lag_str}{factor_name}が{dir_word}傾向があります（{strength_str}）。"
        )
    else:
        body = (
            f"{symptom_name}が出た日は、"
            f"{lag_str}{factor_name}が普段より{dir_word}傾向があります（{strength_str}）。"
        )

    full = body + "\n" + DISCLAIMER
    _assert_safe(full)
    return body, full


def build_experiment_proposal(factor_name: str, direction_positive: bool) -> str:
    """穏当な行動実験を提案する（SAFE-4: 除去・強制を避ける）。"""
    if direction_positive:
        proposal = (
            f"3日間だけ、{factor_name}を意識して少し減らしてみましょう"
            f"（無理のない範囲で）。"
        )
    else:
        proposal = (
            f"3日間だけ、{factor_name}を意識して少し増やしてみましょう"
            f"（無理のない範囲で）。"
        )
    _assert_safe(proposal)
    return proposal


def build_experiment_conclusion(before_rate: float, after_rate: float) -> str:
    """実験前後を控えめに比較する（変化なしも等価に扱う: FR-6.3）。"""
    diff = after_rate - before_rate
    if abs(diff) < 0.05:
        conclusion = "実験の前後で、はっきりした変化は見られませんでした。"
    elif diff < 0:
        conclusion = (
            "実験後、症状の頻度がやや下がる傾向が見られました。"
            "引き続き様子を見てみましょう。"
        )
    else:
        conclusion = (
            "実験後、症状の頻度に変化が見られました。"
            "別の要因も関係しているかもしれません。"
        )
    _assert_safe(conclusion)
    return conclusion


def _assert_safe(text: str) -> None:
    """禁止語が含まれていれば ValueError（SAFE-3/4）。"""
    for word in FORBIDDEN_WORDS:
        if word in text:
            raise ValueError(f"安全配慮違反: 禁止語 '{word}' が検出されました")
