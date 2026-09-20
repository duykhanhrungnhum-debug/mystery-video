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
    source = " ".join([
        "Lưu Bị gặp Trương Phi tại Trác Quận.",
        "Hai người sau đó làm quen với Quan Vũ.",
        "Ba người cùng chí hướng và bàn việc chiêu mộ nghĩa binh.",
        "Họ chuẩn bị vũ khí và tập hợp những người muốn chống quân Khăn Vàng.",
        "Lưu Bị nhớ đến chí hướng cứu dân giữa lúc thiên hạ rối ren.",
        "Trương Phi góp tiền của để giúp việc tuyển quân.",
        "Quan Vũ đồng ý sát cánh cùng hai người trong các trận chiến sắp tới.",
        "Cả ba quyết định cùng lên đường sau khi chuẩn bị xong.",
    ])
    healthy = " ".join([
        "Tại Trác Quận, Lưu Bị gặp Trương Phi và nhanh chóng nhận ra họ có cùng chí hướng.",
        "Không lâu sau, hai người gặp Quan Vũ, một tráng sĩ cũng muốn dẹp loạn cứu dân.",
        "Ba người bàn bạc rồi quyết định chiêu mộ nghĩa binh để chống quân Khăn Vàng.",
        "Trương Phi dùng tiền của trong nhà để hỗ trợ việc mua sắm vũ khí và tuyển người.",
        "Lưu Bị nhắc mọi người rằng mục tiêu của họ là bảo vệ dân chúng giữa thời loạn.",
        "Quan Vũ nhận lời sát cánh, cam kết cùng hai người vượt qua những trận chiến phía trước.",
        "Sau khi quân sĩ và lương thảo được chuẩn bị, đội nghĩa binh bắt đầu hình thành.",
        "Ba người rời Trác Quận với quyết tâm thực hiện chí hướng đã thống nhất.",
    ])

    assert is_degenerate_rewrite(healthy, source) is False


def test_rejects_extreme_expansion_even_without_exact_duplicate_sentence():
    source = "Một đoạn dịch tiếng Việt tương đối ngắn nhưng đầy đủ nội dung. " * 12
    expanded = " ".join(f"chi tiết {i % 17} được nhắc lại theo một cách khác" for i in range(220))

    assert is_degenerate_rewrite(expanded, source) is True
