from pathlib import Path

GPU = Path("scripts/bot2_submit_gpu.py")
CPU = Path("scripts/bot2_submit_cpu_tts.py")
WORKFLOW = Path(".github/workflows/hidden-beyond-bot2-vault.yml")
EDGE = Path("supabase/functions/hidden-beyond-bot2/index.ts")


def test_bot2_pins_worker_and_passes_revision():
    source = GPU.read_text(encoding="utf-8")
    assert 'AI_WORKER_REVISION = "ee13877eedaeffaaa256210a2bb0c1e1be2ddc20"' in source
    assert 'CHECKPOINT_REVISION = "3bf7f1507b3936b56ded8398b078131d72c0ac46"' in source
    assert '"phase":"translation_only"' in source
    assert '"worker_revision":AI_WORKER_REVISION' in source
    assert '"checkpoint_revision":CHECKPOINT_REVISION' in source
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


def test_cpu_tts_worker_has_no_gpu_accelerator():
    source = CPU.read_text(encoding="utf-8")
    assert '"phase": "tts_only"' in source
    assert "enable_gpu=False" in source
    assert '"checkpoint_revision": CHECKPOINT_REVISION' in source


def test_workflow_has_separate_gpu_and_cpu_phases():
    source = WORKFLOW.read_text(encoding="utf-8")
    assert "Follow GPU translation checkpoint" in source
    assert "Submit CPU TTS mix upload job" in source
    assert "Follow CPU TTS mix and YouTube upload" in source
    assert "GPU processing did not finish within 90 minutes" not in source
    assert "timeout-minutes: 240" in source


def test_submitters_compile():
    compile(GPU.read_text(encoding="utf-8"), str(GPU), "exec")
    compile(CPU.read_text(encoding="utf-8"), str(CPU), "exec")
