# Hidden Beyond Bot2

This repository has one production path for the Hidden Beyond YouTube channel.
Older science/story experiments are retained only as historical code and must not
be used as production entry points.

## Single production source of truth

Production contract:

- `docs/bot2-production-pipeline.md`
- `config/hidden_beyond_bot2_pipeline.json`
- `config/hidden_beyond_fixed_sources.json`

Active GitHub Actions:

1. `.github/workflows/hidden-beyond-bot2-vault.yml` — the only production episode workflow.
2. `.github/workflows/hidden-beyond-bot2-cleanup.yml` — maintenance-only stale GPU cleanup.
3. `.github/workflows/test.yml` — CI tests only.

Legacy workflows are stored under `docs/legacy-workflows/` and are not executable
by GitHub Actions.

## Production flow

```text
refresh only the five fixed approved channels
-> select exactly one sequential episode
-> acquire and verify source on CPU
-> acquire usable Chinese captions on CPU when available
-> ASR only when captions are unavailable
-> durable checkpoint
-> GPU contextual translation / bounded targeted repair
-> durable translation checkpoint
-> release GPU immediately
-> CPU VieNeu TTS
-> CPU/ffmpeg timing + original music/SFX mix
-> verify final media
-> YouTube resumable upload as Public
-> verify video exists on Hidden Beyond and privacy=public
-> add/update series playlist and DB
-> advance rotation
-> remove completed checkpoint
```

## Fixed-source policy

- Bot2 uses only the five configured sources in `config/hidden_beyond_fixed_sources.json`.
- Bot2 does not discover or add new channels.
- Episodes are processed sequentially from episode 1 onward.
- Scheduled rotation is 1 -> 2 -> 3 -> 4 -> 5 -> repeat.
- If the current source has no new eligible episode, scheduled mode checks the next fixed source.
- Exact/manual mode never substitutes a different source or episode.

## Resume and GPU policy

Failures are stage-local. Bot2 resumes from the last durable checkpoint instead of
restarting the episode.

- Reuse an already verified source.
- Reuse captions/ASR already completed.
- Continue translation after the saved cursor.
- If translation is complete, skip GPU entirely.
- TTS, audio mix, remux and upload run on CPU.
- Release temporary GPU kernels immediately after the AI stage.
- If YouTube accepted an upload but the final callback failed, recover that upload
  instead of rendering or uploading again.

## Completion rule

A run is complete only when all of these are true:

- the YouTube video exists on the configured Hidden Beyond channel;
- privacy is `public`;
- a non-empty YouTube video ID is recorded;
- playlist and final database completion succeed;
- controller state is `idle/completed`;
- the episode checkpoint is removed after successful finalization.

GitHub Actions `success` alone is not proof that an episode completed.

## Development

Run CI locally with:

```bash
python -m pip install -r requirements.txt
python -m pytest -q
```

Do not place server-side Supabase credentials in browser/mobile/client code.
