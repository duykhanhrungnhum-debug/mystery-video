# Legacy workflows

These files are historical references only. They are intentionally stored outside
`.github/workflows/` so GitHub Actions cannot execute them.

Hidden Beyond production must use only:

- `.github/workflows/hidden-beyond-bot2-vault.yml` — production pipeline.
- `.github/workflows/hidden-beyond-bot2-cleanup.yml` — maintenance-only stale GPU cleanup.
- `.github/workflows/test.yml` — CI tests.

The complete original legacy workflow contents remain available in Git history
at/before commit `d192fdba4766234caf2ba993ed1143f78564340b`.
