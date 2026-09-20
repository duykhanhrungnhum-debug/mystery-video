import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from story_quality import is_degenerate_rewrite


def test_detects_runaway_repetitive_rewrite():
    source = (
        "Lưu Bị gặp Trương Phi và Quan Vũ. Ba người bàn việc chiêu mộ nghĩa binh, "
        "sau đó kết nghĩa và cùng nhau chống quân Khăn Vàng. "
    ) * 8
    broken = (
        "hoàng hôn vừa hoàng hôn vừa hoàng hôn vừa hoàng hôn vừa hoàng hôn "
        "chia chia chia chia chia chia người anh người anh người anh người anh "
    ) * 45

    assert is_degenerate_rewrite(broken, source) is True


def test_accepts_coherent_rewrite_close_to_source_length():
    source = (
        "Lưu Bị gặp Trương Phi tại Trác Quận. Sau đó hai người gặp Quan Vũ. "
        "Cả ba cùng bàn việc chiêu mộ nghĩa binh để chống quân Khăn Vàng. "
    ) * 10
    healthy = (
        "Tại Trác Quận, Lưu Bị gặp Trương Phi rồi làm quen với Quan Vũ. "
        "Ba người cùng chí hướng, quyết định chiêu mộ nghĩa binh và đứng lên "
        "chống quân Khăn Vàng đang gây loạn khắp nơi. "
    ) * 8

    assert is_degenerate_rewrite(healthy, source) is False


def test_rejects_extreme_expansion_even_without_exact_duplicate_sentence():
    source = "Một đoạn dịch tiếng Việt tương đối ngắn nhưng đầy đủ nội dung. " * 12
    expanded = " ".join(f"chi tiết {i % 17} được nhắc lại theo một cách khác" for i in range(220))

    assert is_degenerate_rewrite(expanded, source) is True
