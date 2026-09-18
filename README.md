# Mystery Video

Minimal pipeline for collecting and publishing videos from sources with explicit reuse rights.

## Current MVP

1. Keep a small list of trusted sources in Supabase.
2. Discover new video metadata from an RSS/Atom feed.
3. Store candidates in Supabase and avoid duplicates.
4. Require a rights check before any download/upload step.
5. Later connect YouTube OAuth and upload only rights-cleared items.

This project does **not** download or re-upload arbitrary YouTube videos. A video is eligible only when its reuse rights are documented for that item or it is covered by a source policy that explicitly permits reuse.

## Project layout

- `src/mystery_video/collector.py` - feed discovery and deduplication
- `src/mystery_video/rights.py` - simple rights gate
- `src/mystery_video/db.py` - Supabase access
- `src/mystery_video/cli.py` - minimal command-line entry point
- `tests/` - local tests
- `.env.example` - required environment variables

## Environment

Copy `.env.example` to `.env` and provide:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is server-side only. Never put it in a browser, mobile app, public repository, or client-side bundle.

## First run

```bash
python -m pip install -r requirements.txt
python -m pytest
```

The YouTube OAuth upload step is intentionally not wired yet. It will be added only after the collector and rights gate are verified.
