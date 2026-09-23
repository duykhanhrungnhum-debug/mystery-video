from pathlib import Path
import re


SCRIPT = Path("scripts/bot2_submit_gpu.py")


def test_production_ai_worker_is_pinned_to_verified_commit():
    source = SCRIPT.read_text(encoding="utf-8")
    m = re.search(r'AI_WORKER_REVISION\s*=\s*"([0-9a-f]{40})"', source)
    assert m, "Bot2 must pin a concrete AI worker commit"
    assert "/main/hidden_beyond/longform_audio_worker_v3.py" not in source
    assert "AI_WORKER_REVISION" in source
    assert "ai_worker_revision" in source
