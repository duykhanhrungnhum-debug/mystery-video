from pathlib import Path

GPU = Path("scripts/bot2_submit_gpu.py")
CPU = Path("scripts/bot2_submit_cpu_tts.py")
SOURCE = Path("scripts/bot2_submit_source.py")
REQUEST = Path("scripts/bot2_build_request.py")
WORKFLOW = Path(".github/workflows/hidden-beyond-bot2-vault.yml")
EDGE = Path("supabase/functions/hidden-beyond-bot2/index.ts")


def test_bot2_pins_worker_and_passes_revision():
    source = GPU.read_text(encoding="utf-8")
    assert 'AI_WORKER_REVISION = "aeb350692ffe0cf44aaaaa418814b2fd4c673846"' in source
    assert 'CHECKPOINT_REVISION = "hb-stage-v3-mastery-sync"' in source
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


def test_source_stage_acquires_captions_on_cpu():
    source = SOURCE.read_text(encoding="utf-8")
    assert '"--write-subs","--write-auto-subs"' in source
    assert '"--sub-format","json3"' in source
    assert 'source-caption.%(ext)s' in source
    assert "BOT2_SOURCE_CAPTION" in source


def test_gpu_release_clears_active_state():
    edge = EDGE.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert '/gpu-released' in edge
    assert 'gpu_kernel_ref:null' in edge
    assert 'BOT2_GPU_STATE_CLEARED' in workflow
    assert '$BOT2_API/gpu-released' in workflow


def test_exact_selection_never_falls_back_to_another_rotation():
    edge = EDGE.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    request = REQUEST.read_text(encoding="utf-8")

    assert 'selectionMode=String(request?.selection_mode||"rotation")==="exact"?"exact":"rotation"' in edge
    assert "await peekExact(db,targetRotation,targetEpisode)" in edge
    assert '"target_missing"' in edge
    assert '"target_conflict"' in edge
    assert '"already_completed"' in edge
    assert "bot2-next-request.json" in workflow
    assert "--verify-request bot2-next-request.json" in workflow
    assert "BOT2_SELECTION_GUARD_OK" in request


def test_scheduled_run_uses_rotation_mode_and_manual_target_is_exact():
    source = REQUEST.read_text(encoding="utf-8")
    assert 'if event == "schedule":' in source
    assert '{"selection_mode": "rotation", "run_origin": "schedule"}' in source
    assert 'elif trigger.get("source_rotation") and trigger.get("episode"):' in source
    assert 'mode = "exact"' in source


def test_request_builder_compiles():
    compile(REQUEST.read_text(encoding="utf-8"), str(REQUEST), "exec")


def test_completion_verifies_public_youtube_before_checkpoint_cleanup():
    source = EDGE.read_text(encoding="utf-8")
    assert "async function verifyPublicYoutubeVideo(" in source
    assert 'privacy!=="public"' in source
    assert '"youtube_verify_wrong_channel:"' in source
    assert '["failed","rejected","deleted"].includes(uploadStatus)' in source
    state_pos = source.index('state_success_failed')
    cleanup_pos = source.index('.delete().eq("source_video_id",videoId)', state_pos)
    assert cleanup_pos > state_pos
    assert "checkpoint_cleanup_pending" in source


def test_daily_refresh_is_fixed_source_only_and_runs_before_selection():
    edge = EDGE.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert 'path.endsWith("/refresh-fixed-sources")' in edge
    assert "for(const fixed of FIXED)" in edge
    assert 'src.approval_status!=="approved"' in edge
    assert 'String(v?.status?.privacyStatus||"")==="public"' in edge
    assert 'String(v?.status?.license||"")==="creativeCommon"' in edge
    assert "titleKey.includes(key)" in edge
    assert 'source_url:"https://www.youtube.com/watch?v="+id' in edge
    assert 'rights_status:"approved"' in edge
    refresh_pos = workflow.index("/refresh-fixed-sources")
    next_pos = workflow.index("$BOT2_API/next")
    assert refresh_pos < next_pos
    assert "BOT2_FIXED_SOURCE_REFRESH" in workflow


def test_source_refresh_never_searches_for_new_channels():
    edge = EDGE.read_text(encoding="utf-8")
    assert "ytsearch" not in edge
    assert "search.list" not in edge
    assert "youtube/v3/search" not in edge
    assert 'channelIdFromUrl(src.channel_url)' in edge


def test_source_refresh_paginates_channel_uploads_for_sequential_backfill():
    edge = EDGE.read_text(encoding="utf-8")
    assert 'const maxUploadPages=10' in edge
    assert 'plUrl.searchParams.set("pageToken",pageToken)' in edge
    assert 'pageToken=String(pl?.nextPageToken||"")' in edge
    assert 'if(!pageToken) break' in edge
    assert 'uploadIds.push(...ids)' in edge


def test_fixed_source_channel_recovers_from_verified_seed_video():
    edge = EDGE.read_text(encoding="utf-8")
    assert "resolveFixedSource" in edge
    assert 'locator_type==="seed_video_id"' in edge
    assert '.eq("active",true).eq("verified",true)' in edge
    assert 'v?.snippet?.channelId' in edge
    assert '"resolved_verified_registry"' in edge
    assert 'channel_url:canonicalUrl' in edge


def test_source_registry_is_verified_only_and_health_isolated():
    edge = EDGE.read_text(encoding="utf-8")
    assert 'hidden_beyond_source_locators' in edge
    assert '.eq("active",true).eq("verified",true)' in edge
    assert 'hidden_beyond_source_health' in edge
    assert '"source_refresh_failed"' in edge
    assert 'status:"degraded"' in edge
    assert 'status:"unavailable"' in edge
    assert 'status:"healthy"' in edge
    assert "youtube/v3/search" not in edge


def test_source_discovery_survives_missing_old_episode_metadata():
    edge = EDGE.read_text(encoding="utf-8")
    assert 'inferEpisodeNumber(title)' in edge
    assert 'title_explicit_episode' in edge
    assert 'source_published_at' in edge
    assert 'chronological_after_durable_baseline' in edge
    assert 'ambiguous_episode_without_durable_baseline' in edge
    assert 'baseline_publish_time_missing' not in edge


def test_exact_unavailable_source_stops_before_gpu():
    edge = EDGE.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert '"target_unavailable"' in edge
    assert 'Bot2 source unavailable' in workflow
    assert 'exit 5' in workflow


def test_verified_seed_has_oembed_handle_fallback_without_broad_search():
    edge = EDGE.read_text(encoding="utf-8")
    assert "channelFromVerifiedSeedOembed" in edge
    assert '"https://www.youtube.com/oembed"' in edge
    assert '"forHandle"' in edge
    assert '"forUsername"' in edge
    assert 'method:"oembed_author"' in edge
    assert "youtube/v3/search" not in edge
