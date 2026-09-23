# Hidden Beyond Bot2 — Production Pipeline Standard

This document is the production contract for the Hidden Beyond Bot2 pipeline.
The controller must resume from the last verified stage. It must not restart an
episode from the beginning after a later-stage failure.

## Production flow

```
select episode
  -> CPU source acquisition
  -> CPU Chinese-caption acquisition (preferred)
  -> ASR only when no usable captions exist
  -> checkpoint: asr_complete
  -> GPU contextual translation / bounded repair
  -> checkpoint: translating (periodic cursor)
  -> checkpoint: translation_complete
  -> release temporary GPU kernel immediately
  -> CPU VieNeu TTS
  -> CPU/ffmpeg timing + original music/SFX mix
  -> YouTube resumable upload (Public)
  -> playlist/final DB completion
  -> delete completed episode checkpoint
```

## Checkpoint contract

Checkpoint schema revision: `hb-stage-v2`.

Phases are monotonic:

| Rank | Phase | Durable work |
| --- | --- | --- |
| 10 | `asr_complete` | timed source transcript/captions + transcript metadata |
| 20 | `translating` | transcript + accepted Vietnamese translations through cursor |
| 30 | `translation_complete` | complete translations + timed segments ready for CPU TTS |

A lower-ranked save must never overwrite a higher-ranked checkpoint. A same-rank
save may only move the cursor forward. Existing translated text must not be
erased by an ASR-only save.

## Resume rules

1. Verified source exists: reuse it; never download the same episode again.
2. Usable Chinese captions exist: use them and skip ASR.
3. `asr_complete` exists: skip ASR and continue translation.
4. `translating` exists: load accepted translations and continue after cursor.
5. `translation_complete` has timed segments: skip GPU completely and submit
   CPU TTS/mix/upload.
6. YouTube already accepted the upload but final callback failed: recover the
   existing upload and finish DB/playlist state; do not render or upload again.
7. Delete the episode checkpoint only after final YouTube/playlist completion.

## GPU policy

GPU is allowed only for unfinished AI work that actually requires it.

- Never use GPU for source download.
- Prefer source captions acquired on CPU; use GPU ASR only as fallback.
- Never rerun ASR when an ASR checkpoint exists.
- Never rerun accepted translation segments.
- Never submit GPU when a CPU-ready `translation_complete` checkpoint exists.
- TTS, audio mix, video stream copy, and upload run on CPU.
- Delete/release the temporary GPU kernel immediately after translation handoff,
  including the failure path when safe.
- A stale GPU kernel is a production fault and must be cleaned up.

## Failure policy

Failures are stage-local, not episode-global.

- Network/API failures: bounded retries with backoff.
- Translation structural defects: bounded repair/rescue; preserve prior accepted
  segments before stopping.
- Timeout or worker crash: preserve durable checkpoint and resume from it.
- CPU TTS/mix failure: translation checkpoint remains; next run skips GPU.
- Upload completion failure after YouTube acceptance: use upload recovery.
- Unknown deterministic failures: stop with stage/error evidence. Do not loop
  automatically. After the code/model fix, resume from the preserved checkpoint.

No failure is allowed to silently reset source, ASR, or translation work.

## Quality rules

GPU savings must not lower output quality.

- Translation remains context-aware and genre-aware.
- Deterministic gates reject empty Vietnamese, leaked CJK, and repetition loops.
- TTS remains VieNeu v3 Turbo ONNX int8 on CPU with the production voice.
- Timing is fitted to source dialogue slots.
- Original music/SFX are preserved and ducked under Vietnamese voice.
- Final video copies the source video stream; only audio is remixed.
- YouTube upload privacy is Public.

## Operational evidence

A production run is complete only when evidence shows:

- controller state = `idle/completed`;
- a non-empty YouTube video ID is recorded;
- playlist/final DB completion succeeded;
- episode checkpoint is removed.

GitHub Actions success by itself is not proof that the YouTube episode completed.

## Performance priorities

Optimize in this order without reducing quality:

1. Reuse source and all checkpoints.
2. Caption-first path to avoid ASR.
3. Load only dependencies/models required by the next unfinished stage.
4. Batch translation and TTS efficiently.
5. Release GPU immediately after AI handoff.
6. Measure stage durations and optimize the slowest remaining stage.
