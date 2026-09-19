# Mystery Video

Minimal pipeline for collecting and publishing videos from sources with explicit reuse rights.

## Current MVP

1. Keep a small list of trusted sources in Supabase.
2. Discover new video metadata from an RSS/Atom feed.
3. Store candidates in Supabase and avoid duplicates.
4. Require item-level rights evidence before any download/upload step.
5. Later connect YouTube OAuth and upload only rights-cleared items.

This project does **not** download or re-upload arbitrary YouTube videos. A public YouTube video is not automatically reusable; YouTube documents Standard and Creative Commons licenses separately, and CC BY reuse requires attribution. Rights must be established for the specific item before publication.

## Seeded sources

The Supabase database currently contains five research/media sources:

1. NASA Scientific Visualization Studio - NASA says SVS content is public domain unless otherwise noted; some visualizations contain separately licensed music.
2. NOAA Fisheries Video Gallery - NOAA Fisheries says its narrative videos can be used without permission when shown in full, while third-party clips in those videos may not be extracted; public-domain b-roll packages are also available.
3. NOAA Science On a Sphere - NOAA says digital media it creates is generally not copyrighted, but individual items can have third-party restrictions.
4. U.S. Geological Survey Multimedia - USGS-authored or produced information is U.S. public domain, while third-party material can be separately protected.
5. Library of Congress National Screening Room - many motion pictures have no known U.S. copyright restrictions, but rights are checked per item and exceptions exist.

These policies are source guidance, not blanket permission for every file. The app therefore blocks downloads unless the individual item is marked rights-verified.

## Project layout

- `src/mystery_video/collector.py` - feed discovery and deduplication
- `src/mystery_video/rights.py` - item-level rights gate
- `src/mystery_video/db.py` - Supabase access
- `src/mystery_video/cli.py` - minimal command-line entry point
- `tests/` - local tests
- `.github/workflows/test.yml` - CI test workflow
- `.env.example` - required environment variables

## Environment

Copy `.env.example` to `.env` and provide:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is server-side only. Never put it in a browser, mobile app, public repository, or client-side bundle.

## First run

```bash
python -m pip install -r requirements.txt
python -m pytest -q
```

The YouTube OAuth upload step is intentionally not wired yet. It will be added after the collector and rights gate are verified.


## Ordered public-domain story pipeline

The channel is transitioning from science-footage reuse toward Vietnamese story videos built from rights-cleared source texts.

Current story ingestion rules:

- A series is collected strictly from episode/chapter 1 upward.
- The database records the last collected episode and the next expected episode.
- Once the backlog is caught up, the collector probes only for the next episode and continues sequentially.
- Missing expected episodes stop the series instead of silently skipping ahead.
- Public-domain source text is treated as raw material; generated narration/video is a separate production stage.

Current verified source-text families include Chinese Wikisource editions of Journey to the West, Romance of the Three Kingdoms, Water Margin, Investiture of the Gods, and Strange Tales from a Chinese Studio.

Story processing is intentionally split into stages. The first processor creates a Vietnamese narration script, a Vietnamese voice track, scene prompts, and a private placeholder preview. Placeholder previews are never eligible for automatic YouTube publication. A later visual-generation stage must replace the placeholder with approved AI-generated visuals before an episode can become publish-ready.

Commercial-use guardrails for the current local models:

- Translation: `Helsinki-NLP/opus-mt-zh-vi` (Apache-2.0).
- Narration rewrite: `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0).
- Vietnamese TTS proof pipeline: Piper `vi_VN-vais1000-medium`; retain the model/dataset attribution required by its model card.

The older NLLB processor remains only for the earlier science-video experiment. It is not used by the new story pipeline because the NLLB model is CC-BY-NC and therefore is not selected for a monetization-oriented production path.
