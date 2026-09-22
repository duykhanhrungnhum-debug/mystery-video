# Hidden Beyond Bot2 — lessons carried forward

## Scope
Bot2 exists only to run the fixed Hidden Beyond five-source rotation.
It must not discover, rank, or add new source channels.

## Keep
- Fixed source pool: source IDs 29, 30, 31, 32, 33.
- One episode per job.
- Sequential episodes inside each series.
- Existing YouTube OAuth/upload code that has already uploaded successfully.
- AI stack: Whisper/ASR -> Hy-MT2 Chinese-Vietnamese translation -> VieNeu Vietnamese voice -> mix -> public upload.
- Original visuals stay intact.
- Original music/SFX stay in the mix under the Vietnamese voice.
- Fail-fast status reporting with exact stage/error.

## Do not repeat
- Do not combine source acquisition, AI translation, TTS, recovery, and upload into an opaque worker.
- Do not rerun a full 60-90 minute episode to diagnose one bad segment.
- Do not add multiple translation fallback models/services.
- Do not call GPU until the source file is verified locally.
- Do not treat GitHub workflow SUCCESS as media-processing SUCCESS.
- Do not treat a submitted Kaggle job as a completed Kaggle job.
- Do not retry the same terminal error indefinitely.
- Do not rely on one-day source artifacts as the only copy while debugging.
- Do not make the user provide a file that the Bot is supposed to collect itself.

## Root causes learned from Bot1
1. Source acquisition became unstable after it was moved into the end-to-end Kaggle worker.
2. Public YouTube downloads from shared GitHub/Kaggle cloud IPs can be blocked by "Sign in to confirm you're not a bot".
3. ASR can produce repeated Chinese phrases; normalize obvious ASR repetition before translation.
4. Translation QA must separate structural blockers from review-only heuristics.
5. One structural segment must not force a complete video rerun.
6. Media, translation, TTS, and upload status must be distinguishable.
7. GPU quota must only be used after source acquisition succeeds.

## Bot2 production shape
1. Pick next episode from the fixed 1->5 rotation.
2. Acquire and verify source on CPU.
3. Only then start AI/GPU work.
4. ASR once.
5. Hy-MT2 once + at most one targeted repair pass.
6. VieNeu once.
7. Mix/remux with original visuals.
8. Verify audio/video duration.
9. Upload Public to YouTube.
10. Advance rotation only after verified upload.

## Failure rule
- A stage may use only a small bounded retry for transient transport errors.
- Any terminal logic/content error stops the current job and records the exact stage.
- Rotation advances only after success, or when the current source has no new episode.
