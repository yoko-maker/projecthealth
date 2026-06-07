"""言語化モジュールのテスト（仕様書 18章）。
全出力への免責文付与・禁止語チェック・最大2件制限を検証する。
"""
import pytest
from app.verbalize import (
    build_text, build_experiment_proposal, build_experiment_conclusion,
    DISCLAIMER, FORBIDDEN_WORDS, _assert_safe,
)


class TestBuildText:
    def test_disclaimer_always_appended(self):
        """すべての仮説テキストに免責文が必ず付く（SAFE-3）。"""
        _, full = build_text("頭痛", "睡眠時間", lag=1,
                             direction_positive=False,
                             strength="mild", factor_dtype="continuous")
        assert DISCLAIMER in full

    def test_lag0_no_prefix(self):
        body, _ = build_text("頭痛", "睡眠時間", lag=0,
                             direction_positive=False, strength="mild",
                             factor_dtype="continuous")
        assert "前日" not in body
        assert "一昨日" not in body

    def test_lag1_prefix(self):
        body, _ = build_text("頭痛", "睡眠時間", lag=1,
                             direction_positive=False, strength="mild",
                             factor_dtype="continuous")
        assert "前日の" in body

    def test_lag2_prefix(self):
        body, _ = build_text("頭痛", "睡眠時間", lag=2,
                             direction_positive=False, strength="mild",
                             factor_dtype="continuous")
        assert "一昨日の" in body

    def test_strength_clear_label(self):
        body, _ = build_text("気分の落ち込み", "雨の日", lag=0,
                             direction_positive=True, strength="clear",
                             factor_dtype="binary")
        assert "はっきり" in body

    def test_strength_mild_label(self):
        body, _ = build_text("頭痛", "睡眠時間", lag=1,
                             direction_positive=False, strength="mild",
                             factor_dtype="continuous")
        assert "ややあり" in body

    def test_contains_symptom_name(self):
        body, _ = build_text("偏頭痛", "カフェイン", lag=0,
                             direction_positive=True, strength="mild",
                             factor_dtype="continuous")
        assert "偏頭痛" in body

    def test_contains_factor_name(self):
        body, _ = build_text("偏頭痛", "カフェイン", lag=0,
                             direction_positive=True, strength="mild",
                             factor_dtype="continuous")
        assert "カフェイン" in body


class TestForbiddenWords:
    def test_forbidden_word_raises(self):
        """禁止語が含まれたら ValueError を発生させる（SAFE-3/4）。"""
        for word in FORBIDDEN_WORDS:
            with pytest.raises(ValueError, match="禁止語"):
                _assert_safe(f"これは{word}影響です")

    def test_safe_text_passes(self):
        """通常の仮説文は検査を通過する。"""
        _assert_safe("頭痛が出た日は、前日の睡眠時間が普段より少なめ傾向があります（ややあり）。\n" + DISCLAIMER)


class TestExperimentProposal:
    def test_no_forbidden_words(self):
        proposal = build_experiment_proposal("睡眠時間", direction_positive=False)
        for word in FORBIDDEN_WORDS:
            assert word not in proposal

    def test_gentle_language_positive(self):
        proposal = build_experiment_proposal("ストレス", direction_positive=True)
        assert "減らし" in proposal

    def test_gentle_language_negative(self):
        proposal = build_experiment_proposal("睡眠時間", direction_positive=False)
        assert "増やし" in proposal


class TestExperimentConclusion:
    def test_no_change(self):
        conclusion = build_experiment_conclusion(0.5, 0.5)
        assert "変化" in conclusion
        assert "見られませんでした" in conclusion

    def test_improved(self):
        conclusion = build_experiment_conclusion(0.7, 0.3)
        assert "下がる" in conclusion

    def test_worsened_or_changed(self):
        conclusion = build_experiment_conclusion(0.3, 0.6)
        assert "変化" in conclusion

    def test_no_forbidden_in_conclusions(self):
        for before, after in [(0.5, 0.5), (0.8, 0.2), (0.2, 0.8)]:
            text = build_experiment_conclusion(before, after)
            for word in FORBIDDEN_WORDS:
                assert word not in text
