# Hidden Beyond Bot2 — Production Pipeline Standard

This document is the production contract for the Hidden Beyond Bot2 pipeline.
The controller must resume from the last verified stage. It must not restart an
episode from the beginning after a later-stage failure.

## Production flow

```
refresh only the five fixed approved YouTube channels
  -> select exactly one episode
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

Checkpoint schema revision: `hb-stage-v3-mastery-sync`.

Phases are monotonic:

| Rank | Phase | Durable work |
| --- | --- | --- |
| 10 | `asr_complete` | timed source transcript/captions + transcript metadata |
| 20 | `translating` | transcript + accepted Vietnamese translations through cursor |
| 30 | `translation_complete` | complete translations + timed segments ready for CPU TTS |

A lower-ranked save must never overwrite a higher-ranked checkpoint. A same-rank
save may only move the cursor forward. Existing translated text must not be
erased by an ASR-only save.

## Selection modes

Bot2 has two deliberately different selection modes:

- **Exact/manual:** a requested rotation + episode must match exactly. Missing,
  invalid, completed, or conflicting targets stop before source download/GPU.
  The controller must never substitute another rotation or episode.
- **Scheduled/daily rotation:** refresh only the five fixed approved channels,
  then start at `next_rotation`. If that source has no new approved episode,
  check the next fixed source in rotation order. One workflow invocation claims
  at most one episode.

The pre-selection refresh never searches broadly for new channels. It reads the\nfive fixed sources and their admin-configured failover seeds, matches videos to\nthe tracked series, and only queues items whose current YouTube metadata is\nPublic. The current YouTube license value is recorded for evidence but is not a\nproduction gate for the already configured fixed-source pool.



## Fixed-source access contract

The five configured sources are already approved/trusted inputs. Bot2 does not
re-verify source identity on every run and does not quarantine a fixed source
because one YouTube API path fails.

Discovery order is deliberately simple:

1. Try YouTube Data API against the stored fixed channel.
2. If that API path cannot list the channel/uploads, run yt-dlp against the same
   fixed channel or an already stored seed episode from that source.
3. Ingest matching episodes and continue the normal production pipeline.
4. Never perform broad searches for replacement channels or new sources.

A failed discovery method is not a source-identity failure. Only after both
access methods fail is the requested episode reported as missing. Exact/manual
runs report that as a real workflow failure before download/GPU; scheduled
rotation can continue to the next fixed source.

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
A deterministic content-shape issue that can be normalized safely (for example,
an overlong dialogue cue) is normalized and checkpointed rather than failing the
whole episode.

## Quality rules

GPU savings must not lower output quality.

Translation mastery profile:
- Use context before/after the current cue and accepted prior Vietnamese lines.
- Keep xianxia roles, honorifics, names, realms, sect terms, idioms, negation,
  numbers and emotional force consistent across the episode.
- In xianxia scenes, do not default to modern `tôi/bạn` when the relationship
  calls for `ta/ngươi/nàng/hắn` or role-based forms.
- Short Chinese dialogue should remain concise Vietnamese dialogue rather than
  being expanded into explanations.
- Flag unnatural modern pronouns and verbose short-line translations for one
  bounded targeted repair pass.

Dubbing synchronization:
- Place each Vietnamese cue inside a source-dialogue timing window derived from
  the original cue and its neighboring cues.
- Allow only small pre-roll/post-roll around the original speech window.
- Fit translation length to realistic TTS cadence before synthesis.
- Finish a cue before the next source cue whenever possible; hard trimming is a
  last-resort fallback and is recorded in output metadata.
- Record maximum start shift and end overrun for sync diagnostics.

- Translation remains context-aware and genre-aware.
- Deterministic gates reject empty Vietnamese, leaked CJK, and repetition loops.
- TTS remains VieNeu v3 Turbo ONNX int8 on CPU with the production voice.
- Timing is fitted to source dialogue slots.
- Original music/SFX are preserved and ducked under Vietnamese voice.
- Final video copies the source video stream; only audio is remixed.
- YouTube upload privacy is Public.

## Operational evidence

A production run is complete only when evidence shows:

- YouTube confirms the video exists on the configured Hidden Beyond channel;
- YouTube confirms privacy = `public`;
- controller state = `idle/completed`;
- a non-empty YouTube video ID is recorded;
- playlist/final DB completion succeeded;
- episode checkpoint is removed only after final state succeeds.

GitHub Actions success by itself is not proof that the YouTube episode completed.

## Performance priorities

Optimize in this order without reducing quality:

1. Reuse source and all checkpoints.
2. Caption-first path to avoid ASR.
3. Load only dependencies/models required by the next unfinished stage.
4. Batch translation and TTS efficiently.
5. Release GPU immediately after AI handoff.
6. Measure stage durations and optimize the slowest remaining stage.

## Known remaining optimization

CPU TTS is intentionally outside the GPU path. A failed CPU TTS job currently
restarts TTS from the beginning of that episode, while retaining the completed
translation checkpoint so GPU translation is not repeated. Persistent TTS-chunk
resume is a future CPU-time optimization, not a GPU-safety blocker.
