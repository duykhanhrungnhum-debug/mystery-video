from pathlib import Path

GPU = Path("scripts/bot2_submit_gpu.py")
EDGE = Path("supabase/functions/hidden-beyond-bot2/index.ts")


def test_bot2_pins_worker_and_passes_revision():
    source = GPU.read_text(encoding="utf-8")
    assert 'AI_WORKER_REVISION = "3bf7f1507b3936b56ded8398b078131d72c0ac46"' in source
    assert '"worker_revision":AI_WORKER_REVISION' in source
    assert '"ai_worker_revision":AI_WORKER_REVISION' in source


def test_checkpoint_api_is_worker_authenticated_and_revision_scoped():
    source = EDGE.read_text(encoding="utf-8")
    assert '/translation-checkpoint-get' in source
    assert '/translation-checkpoint-save' in source
    assert 'authorizeWorker(req,db,body)' in source
    assert 'worker_revision_mismatch' in source
    assert 'checkpoint_payload_too_large' in source


def test_success_cleans_translation_checkpoint():
    source = EDGE.read_text(encoding="utf-8")
    assert 'hidden_beyond_bot2_checkpoints' in source
    assert '.delete().eq("source_video_id",videoId)' in source
