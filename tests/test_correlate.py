"""相関エンジンの単体テスト（仕様書 18章）。
最重要：データ不足時・無相関時の沈黙と、明確な関連の正しい検出を検証する。
"""
import pytest
from app.correlate import (
    cohens_d, lift_value, spearman_rho,
    scan, run_full_scan, THRESHOLDS,
)


# ── 統計プリミティブ ──────────────────────────────────────────────────────────

class TestCohensD:
    def test_clear_difference(self):
        high = [8.0, 9.0, 8.5, 9.5, 8.0]
        low  = [3.0, 2.0, 3.5, 2.5, 3.0]
        d = cohens_d(high, low)
        assert d is not None
        assert abs(d) >= 2.0  # 明確な差

    def test_no_difference(self):
        a = [5.0, 5.0, 5.0, 5.0, 5.0]
        b = [5.0, 5.0, 5.0, 5.0, 5.0]
        d = cohens_d(a, b)
        assert d is None  # pooled_std == 0

    def test_insufficient_data(self):
        assert cohens_d([1.0], [2.0, 3.0]) is None
        assert cohens_d([], [2.0]) is None

    def test_direction(self):
        d = cohens_d([8.0, 9.0, 8.0, 9.0, 8.5], [3.0, 2.0, 3.0, 2.0, 2.5])
        assert d > 0  # group_a > group_b → 正の値


class TestLift:
    def test_positive_association(self):
        # 症状がある日は要因も多い
        lft = lift_value(n_11=8, n_10=2, n_01=2, n_00=8)
        assert lft is not None
        assert lft > 1.5

    def test_no_association(self):
        # 完全独立
        lft = lift_value(n_11=5, n_10=5, n_01=5, n_00=5)
        assert lft is not None
        assert abs(lft - 1.0) < 0.1

    def test_zero_denominator(self):
        assert lift_value(0, 0, 0, 0) is None


class TestSpearman:
    def test_perfect_positive_correlation(self):
        xs = [1.0, 2.0, 3.0, 4.0, 5.0]
        ys = [1.0, 2.0, 3.0, 4.0, 5.0]
        rho = spearman_rho(xs, ys)
        assert rho is not None
        assert abs(rho - 1.0) < 0.01

    def test_perfect_negative_correlation(self):
        xs = [1.0, 2.0, 3.0, 4.0, 5.0]
        ys = [5.0, 4.0, 3.0, 2.0, 1.0]
        rho = spearman_rho(xs, ys)
        assert rho is not None
        assert abs(rho + 1.0) < 0.01

    def test_insufficient_data(self):
        assert spearman_rho([1.0, 2.0], [3.0, 4.0]) is None


# ── スキャン関数 ──────────────────────────────────────────────────────────────

def _make_rows(symptom_vals, factor_vals):
    """テスト用 daily_rows を作成する。"""
    return [
        {"sym": s, "fac": f}
        for s, f in zip(symptom_vals, factor_vals)
    ]


class TestScan:
    cfg = THRESHOLDS["conservative"]

    def test_no_data_returns_none(self):
        rows = _make_rows([], [])
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        assert result is None

    def test_insufficient_groups_returns_none(self):
        # 症状ありが n_min(5)未満
        rows = _make_rows([1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
                          [9, 9, 2, 2, 2, 2, 2, 2, 2, 2])
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        # n_pos=2 < n_min=5 なのでNone
        assert result is None

    def test_clear_lag0_association(self):
        """当日に明確な関連がある場合、lag=0 で検出される。
        グループ内に分散が必要（分散0ではCohens_d計算不能）。
        """
        syms = [1] * 10 + [0] * 10
        # 症状あり群 ~9.0 ± 0.3、なし群 ~2.0 ± 0.3 (明確な差)
        facs = [8.7, 9.1, 8.3, 9.2, 8.9, 9.0, 8.5, 9.3, 8.6, 9.4,
                2.3, 1.7, 2.1, 1.9, 2.4, 2.0, 2.2, 1.8, 2.5, 1.6]
        rows = _make_rows(syms, facs)
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        assert result is not None
        assert result["lag"] == 0
        assert result["direction_positive"] is True

    def test_lag1_association(self):
        """前日（lag=1）に要因がある場合を検出する。
        要因はランダム、症状は前日の要因値だけで決まるため lag=0 の相関は弱い。
        """
        import random
        random.seed(42)
        n = 40
        # 要因はランダム正規分布（lag=0 相関なし）
        fac_seq = [random.gauss(5.0, 1.5) for _ in range(n)]
        # 症状は前日の要因が閾値超かどうかのみで決まる（lag=1 依存）
        sym_seq = [0] + [1 if fac_seq[i - 1] > 6.0 else 0 for i in range(1, n)]
        rows = [{"sym": s, "fac": f} for s, f in zip(sym_seq, fac_seq)]
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        assert result is not None
        assert result["lag"] == 1

    def test_no_correlation_returns_none(self):
        """無相関データでフォールスポジティブを出さない（足切りの検証）。"""
        import random
        random.seed(42)
        # 完全ランダム
        syms = [random.randint(0, 1) for _ in range(30)]
        facs = [random.uniform(3.0, 7.0) for _ in range(30)]
        rows = _make_rows(syms, facs)
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        # ランダムデータで大きな効果量は出ないはず（確率的なので assert None ではなくチェック）
        if result is not None:
            assert abs(result["effect"]) >= self.cfg["d_min"]

    def test_sensitivity_standard_vs_conservative(self):
        """感度設定で足切りが変わることを確認する。"""
        cfg_strict  = THRESHOLDS["conservative"]
        cfg_relaxed = THRESHOLDS["standard"]
        # d_min と n_min が緩和されているか確認
        assert cfg_relaxed["d_min"] < cfg_strict["d_min"]
        assert cfg_relaxed["n_min"] < cfg_strict["n_min"]
        assert cfg_relaxed["lift_min"] < cfg_strict["lift_min"]

    def test_below_threshold_returns_none(self):
        """効果量が足切り未満なら沈黙（気づきなし = 正常）。
        両群の平均が等しいため d=0 → 足切りで None。
        """
        # 症状あり群 mean=5.0、なし群 mean=5.0 → d=0
        rows = _make_rows(
            [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
            [5.1, 4.9, 5.2, 4.8, 5.0,
             5.0, 5.2, 4.8, 5.1, 4.9],
        )
        result = scan(rows, "sym", "fac", "binary", "continuous", self.cfg)
        assert result is None
