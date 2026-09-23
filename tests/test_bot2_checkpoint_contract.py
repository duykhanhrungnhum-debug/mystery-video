from pathlib import Path

GPU = Path("scripts/bot2_submit_gpu.py")
CPU = Path("scripts/bot2_submit_cpu_tts.py")
WORKFLOW = Path(".github/workflows/hidden-beyond-bot2-vault.yml")
EDGE = Path("supabase/functions/hidden-beyond-bot2/index.ts")


def test_bot2_pins_worker_and_passes_revision():
    source = GPU.read_text(encoding="utf-8")
    assert 'AI_WORKER_REVISION = "dc2e0efad88d567e2d57063836a4f940e23dcfed"' in source
    assert 'CHECKPOINT_REVISION = "hb-stage-v2"' in source
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


def test_checkpoint_state_machine_is_monotonic():
    source = EDGE.read_text(encoding="utf-8")
    assert "asr_complete:10" in source
    assert "translating:20" in source
    assert "translation_complete:30" in source
    assert 'oldRank>newRank' in source
    assert 'finalPayload={...oldPayload,...payload}' in source
    assert 'checkpoint_cpu_ready' in source


def test_completed_checkpoint_skips_gpu_and_gpu_is_released():
    source = WORKFLOW.read_text(encoding="utf-8")
    assert 'steps.claim.outputs.need_gpu == \'true\'' in source
    assert "BOT2_RESUME_STAGE translation_complete cpu_ready=true; GPU will be skipped" in source
    assert "Release temporary GPU kernel" in source
    assert "/delete-kernel" in source
    assert "BOT2_GPU_RELEASED" in source
